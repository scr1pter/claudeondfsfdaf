export * as ResearchStore from "./store"

import { createHash, randomBytes } from "node:crypto"
import { and, asc, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm"
import { Context, Effect, Layer, Option, Queue, Schema, Scope, Semaphore } from "effect"
import { Research } from "@vectordevai/schema/research"
import type { Brain } from "../brain/brain"
import { BrainCard } from "../brain/card"
import { BrainDatabase } from "../brain/database"
import { BrainLimits } from "../brain/document/limits"
import { BrainDocument } from "../brain/document/read"
import { BrainEmbed } from "../brain/embed"
import { BrainKnowledge } from "../brain/knowledge"
import { BrainLexical } from "../brain/lexical"
import { BrainScan } from "../brain/scan"
import { BrainSchema } from "../brain/schema"
import {
  BrainDocumentTable,
  BrainItemTable,
  BrainPassageTable,
  BrainPostingTable,
  BrainSectionTable,
  BrainStateTable,
  BrainTermTable,
  BrainTombstoneTable,
  BrainVectorTable,
  ResearchNoteTable,
  ResearchRunTable,
  ResearchSourceTable,
} from "../brain/sql"
import { BrainStructure } from "../brain/structure"
import { BrainVector } from "../brain/vector"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { Location } from "../location"
import { AbsolutePath } from "../schema"
import { Token } from "../util/token"
import { ResearchDedupe } from "./dedupe"
import { ResearchClaim } from "./claim"
import { ResearchQuote } from "./quote"
import type { ResearchReader } from "./reader"
import { ResearchReport } from "./report"

// Deep research's run store, one brain per repository: runs keyed by the root session, so researchers write into
// their parent's run, with the pages they read (S1, S2, ...), the notes whose quotes were found in those pages (N1,
// N2, ...) and the report.
//
// - Every page read is a brain document of origin web: private, held for the reason `web`, and its passages held one by
//   one too, so recall, search and citations never serve one, whoever approves what. Its passages are indexed by
//   keyword (BM25) at once. Only passages a note quotes, and the report, get vectors, embedded when the machine is
//   idle; reading 25 pages embeds about 80 passages rather than about 2,000.
// - The report is a held, private document of origin research. Keep makes it recallable for the owner, as any private
//   document is: never for a session a guest is in, nor for a model that may train on prompts. Calling the report
//   again saves the next version, held again until it is kept.
// - Quotes are checked against the run's own saved text (`quoted`), since the brain's own quote check refuses held
//   documents, which these are.
// - A run nobody kept is deleted after 30 days. Research in a repository is capped at 1 GB; past it, the oldest runs
//   nobody kept go first, and the add says so. A run keeps at most 80 sources and 40 MB of their text.
// - Forget (a source, a run, the runs of a session, all of a repository's research) deletes the text and leaves
//   tombstones, so a later run does not keep a forgotten page again on its own. Erasing memory forgets research too
//   (BrainErase): a session's runs with what Vector learned in it, a repository's with its memory, every run with all.
// - A run a guest acted in keeps nothing in the brain: it lives in a brain in this process's memory, which is gone
//   when the process ends. Its report stays in the session's transcript.

export const LIMIT = {
  /** Sources one run keeps, and the cleaned text of its pages. */
  sources: 80,
  bytes: 40 * 1024 * 1024,
  /** Research one repository keeps, every run together. */
  repository: 1024 * 1024 * 1024,
  /** Days a run nobody kept stays. */
  retain: 30,
} as const

export type Limits = {
  readonly sources: number
  readonly bytes: number
  readonly repository: number
  readonly retain: number
}

export const NO_RUN = "There is no such research run here. Start one with research_plan."
export const GUEST =
  "An invited guest acted in this session, so this run stays out of the brain. Its report is in the session."
export const FORGOTTEN = "You forgot this page in an earlier run, so Vector does not keep it again."
export const PAGES = "Page budget used: write the report from what you have."
export const SEARCHES = "Search budget used: write the report from what you have."

const DAY = 24 * 60 * 60 * 1000
/** How long a forgotten page stays forgotten, as a forgotten document does. */
const TOMBSTONE = 180 * DAY
/** The retention sweep runs at most this often in one process. */
const SWEEP_EVERY = 60 * 60 * 1000
/** The background embedder looks again this often while it has nothing to do. */
const IDLE = 30_000
/** Runs whose pages dedupe keeps in memory; a page's shingles can run to tens of thousands. */
const FINGERPRINTED = 8

export type StartInput = {
  /** The root session: researchers launched from it write into the same run. */
  readonly sessionID: string
  readonly question: string
  readonly depth: Research.Depth
  readonly scope: Research.Scope
  readonly plan?: Research.Plan
  /** The page and search budget, which `addSource` and `searched` enforce. */
  readonly budget?: { readonly pages?: number; readonly searches?: number }
  /** An invited guest acted in the session: the run lives in memory only, never in the brain. */
  readonly guest?: boolean
}

/** A page as the reader (or a research browser) read it. `ResearchReader.Page` is one. */
export type SourceInput = Pick<ResearchReader.Page, "url" | "canonical" | "site" | "title" | "status" | "chunks"> & {
  readonly reason?: string
  readonly format?: string
  readonly pages?: number
  readonly private?: boolean
  readonly fingerprint?: ResearchDedupe.Fingerprint
  readonly meta?: Pick<ResearchReader.Meta, "author" | "published">
  readonly signals?: Research.Signal
  readonly fetchedAt?: number
}

export type Added =
  /** Saved as a new source; `evicted` names runs forgotten to make room, oldest first. */
  | { readonly type: "added"; readonly source: Research.Source; readonly evicted?: readonly string[] }
  /** A copy of a source the run read: saved as a copy, with no text of its own. */
  | { readonly type: "duplicate"; readonly source: Research.Source; readonly of: string }
  /** The run already read this address: reading it again is free. */
  | { readonly type: "known"; readonly source: Research.Source }
  | { readonly type: "refused"; readonly message: string }

/** A source with its saved text, chunk by chunk. */
export type Saved = {
  readonly source: Research.Source
  readonly chunks: readonly ResearchQuote.Part[]
  /** Read from the user's own computer or network: private context, never public text. */
  readonly private: boolean
  /** Its page was forgotten since it was read, so its text is gone. */
  readonly forgotten: boolean
}

export type Quoted =
  | {
      readonly ok: true
      readonly chunk: number
      readonly page?: number
      readonly passage?: string
      /** The source's own words for the quote. */
      readonly quote: string
    }
  | { readonly ok: false; readonly reason: "short" | "missing" | "no-source"; readonly message: string }

export type NoteInput = {
  readonly subquestion: string
  readonly claim: string
  /** "S3". */
  readonly source: string
  readonly quote: string
  readonly page?: number
  readonly stance?: Research.Stance
  readonly measurement?: Research.Measurement
  /** Researchers cannot receive comparison signals derived from the lead's private pages. */
  readonly publicOnly?: boolean
}

export type Noted =
  | { readonly type: "saved"; readonly note: Research.Note; readonly comparisons?: readonly ResearchClaim.Comparison[] }
  | { readonly type: "refused"; readonly message: string }

export type ReportOptions = {
  /** The research judge ran on this report. */
  readonly judged?: boolean
  /** What research spent and how long it took, already worded. */
  readonly spend?: string
  readonly seconds?: number
}

export type Reported =
  | {
      readonly type: "saved"
      readonly rendered: ResearchReport.Rendered
      /** The held document, or none for a run a guest acted in. */
      readonly document?: string
      readonly version: number
      readonly uncited: readonly string[]
    }
  | { readonly type: "refused"; readonly errors: readonly string[]; readonly uncited: readonly string[] }

export type Summary = {
  readonly run: Research.Run
  readonly sources: number
  readonly notes: number
  /** Bytes of page and report text the run keeps in the brain. */
  readonly bytes: number
}

export type Detail = {
  readonly run: Research.Run
  /** Every source, skipped ones and copies included; `forgotten` for a page whose text was forgotten since. */
  readonly sources: readonly (Research.Source & { readonly forgotten?: boolean })[]
  readonly notes: readonly Research.Note[]
  readonly queries: readonly string[]
  /** The latest report, as research_report rendered it. */
  readonly report?: string
  /** Bytes of page and report text the run keeps. */
  readonly bytes: number
  /** A guest acted in the run's session, so it is in memory only. */
  readonly guest: boolean
}

export type Exported = { readonly name: string; readonly type: string; readonly body: string }

export type ForgetAllOptions = { readonly everywhere?: boolean; readonly session?: string }

export interface Interface {
  readonly start: (place: Brain.Place, input: StartInput) => Effect.Effect<Research.Run>
  /** The newest run of a root session that is still planned or running. */
  readonly active: (place: Brain.Place, sessionID: string) => Effect.Effect<Research.Run | undefined>
  /** The plan as the user approved it, or a change of sub-question status; `status` moves the run on. */
  readonly plan: (
    place: Brain.Place,
    runID: string,
    plan: Research.Plan,
    status?: Research.RunStatus,
  ) => Effect.Effect<Research.Run | undefined>
  readonly status: (
    place: Brain.Place,
    runID: string,
    status: Research.RunStatus,
  ) => Effect.Effect<Research.Run | undefined>
  /** Steps taken and money spent since the last count. */
  readonly count: (
    place: Brain.Place,
    runID: string,
    input: { readonly steps?: number; readonly cost?: number },
  ) => Effect.Effect<Research.Run | undefined>
  /** A search about to be sent: counted against the budget and kept for the Sources tab, or refused. */
  readonly searched: (
    place: Brain.Place,
    runID: string,
    query: string,
  ) => Effect.Effect<
    { readonly type: "counted"; readonly searches: number } | { readonly type: "refused"; readonly message: string }
  >
  readonly addSource: (place: Brain.Place, runID: string, input: SourceInput) => Effect.Effect<Added>
  /** A source and its saved text, by "S3"; reading it again makes no network call. */
  readonly source: (place: Brain.Place, runID: string, ref: string) => Effect.Effect<Saved | undefined>
  /** The source's chunks that share most words with `query`, best first (BM25 over its own chunks). */
  readonly focus: (
    place: Brain.Place,
    runID: string,
    ref: string,
    query: string,
    limit?: number,
  ) => Effect.Effect<readonly ResearchQuote.Part[]>
  /** Whether a quote is in a source's saved text, normalised: the first of research_note's two checks. */
  readonly quoted: (place: Brain.Place, runID: string, ref: string, quote: string) => Effect.Effect<Quoted>
  readonly note: (place: Brain.Place, runID: string, input: NoteInput) => Effect.Effect<Noted>
  /** What the research judge said of each note it was given. */
  readonly judged: (
    place: Brain.Place,
    runID: string,
    verdicts: readonly { readonly note: string; readonly verdict: Research.Verdict }[],
  ) => Effect.Effect<number>
  readonly report: (
    place: Brain.Place,
    runID: string,
    input: Research.ReportInput,
    options?: ReportOptions,
  ) => Effect.Effect<Reported>
  readonly get: (place: Brain.Place, runID: string) => Effect.Effect<Detail | undefined>
  /** The repository's runs in the brain, newest first. */
  readonly list: (place: Brain.Place) => Effect.Effect<readonly Summary[]>
  /** Keeps the run, and makes its report recallable for the owner. */
  readonly keep: (
    place: Brain.Place,
    runID: string,
  ) => Effect.Effect<
    | { readonly type: "kept"; readonly run: Research.Run }
    | { readonly type: "refused"; readonly message: string }
    | undefined
  >
  readonly forget: (place: Brain.Place, runID: string) => Effect.Effect<boolean>
  readonly forgetSource: (place: Brain.Place, runID: string, ref: string) => Effect.Effect<boolean>
  /**
   * Every run of the repository, or with `everywhere` of every repository (Erase all), or with `session` only the runs
   * that root session started (Erase what Vector learned in a session); how many there were.
   */
  readonly forgetAll: (place: Brain.Place, options?: ForgetAllOptions) => Effect.Effect<number>
  readonly export: (
    place: Brain.Place,
    runID: string,
    format: "markdown" | "json",
  ) => Effect.Effect<Exported | undefined>
  /** An invited guest acted in the run's session: what the run holds leaves the brain for this process's memory. */
  readonly guest: (place: Brain.Place, runID: string) => Effect.Effect<void>
  /** Deletes runs nobody kept that are older than the retention; how many went. */
  readonly sweep: (now?: number) => Effect.Effect<number>
  /** Embeds what is waiting (noted passages and reports) now; the background embedder does it when idle. */
  readonly embed: () => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@vector/ResearchStore") {}

export type Options = { readonly limits?: Partial<Limits> }

export const layerWith = (options: Options = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const database = yield* BrainDatabase.Service
      const knowledge = yield* BrainKnowledge.Service
      const embed = yield* BrainEmbed.Service
      const events = yield* EventV2.Service
      const scope = yield* Effect.scope
      const wakeup = yield* Queue.sliding<void>(1)
      // A brain in this process's memory, for runs a guest acted in; made on the first one.
      const ephemeral = yield* Effect.cached(
        Layer.buildWithScope(BrainDatabase.layerFor(":memory:").pipe(Layer.fresh), scope).pipe(
          Effect.map((context) => Context.get(context, BrainDatabase.Service).db),
          Effect.orDie,
        ),
      )
      return make({
        db: database.db,
        ephemeral,
        knowledge,
        embed,
        events,
        scope,
        wakeup,
        limits: { ...LIMIT, ...options.limits },
      })
    }),
  )

export const layer = layerWith()

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [BrainDatabase.node, BrainKnowledge.node, BrainEmbed.node, EventV2.node],
})

type Database = BrainDatabase.Database
type RunRow = typeof ResearchRunTable.$inferSelect
type SourceRow = typeof ResearchSourceTable.$inferSelect
type Found = { readonly db: Database; readonly row: RunRow; readonly guest: boolean }

/** A document the store writes: a page a run read, or a version of its report. */
type Written = {
  readonly id: string
  readonly origin: "web" | "research"
  readonly runID: string
  readonly sessionID: string
  readonly lineage: string
  readonly version: number
  readonly previous?: string
  readonly name: string
  readonly title: string
  readonly format: BrainSchema.Format
  readonly hash: string
  readonly bytes: number
  readonly tokens: number
  readonly pages?: number
  readonly sourceUrl?: string
  readonly fetchedAt?: number
  readonly sections: readonly {
    readonly id: string
    readonly ordinal: number
    readonly parent?: number
    readonly level: number
    readonly heading: string
    readonly path: string
    readonly pageStart?: number
    readonly pageEnd?: number
    readonly tokens: number
  }[]
  readonly passages: readonly {
    readonly id: string
    readonly section: number
    readonly ordinal: number
    readonly page?: number
    readonly header: string
    readonly body: string
    readonly tokens: number
    readonly start: number
    readonly end: number
    readonly normHash: string
    readonly hold?: BrainSchema.Hold
  }[]
}

function make(input: {
  readonly db: Database
  readonly ephemeral: Effect.Effect<Database>
  readonly knowledge: BrainKnowledge.Interface
  readonly embed: BrainEmbed.Interface
  readonly events: EventV2.Interface
  readonly scope: Scope.Scope
  readonly wakeup: Queue.Queue<void>
  readonly limits: Limits
}): Interface {
  const db = input.db
  const knowledge = input.knowledge
  const limits = input.limits
  // One writer at a time in this process, so two researchers of a run never number a source or a note alike.
  const lock = Semaphore.makeUnsafe(1)
  const state = {
    // Runs a guest acted in, which live in the memory brain.
    guests: new Set<string>(),
    // The latest runs' read pages as dedupe compares them, built again from the saved text when a run was pushed out.
    fingerprints: new Map<string, ResearchDedupe.Known[]>(),
    swept: 0,
    embedder: false,
  }

  // An event takes the caller's location when it has one (a V2 request or session). The engine's V1 routes and tools
  // carry none, so it is then the repository's working tree, which is the directory the app opened it at.
  const publish = Effect.fnUntraced(function* (
    place: Brain.Place,
    runID: string,
    status: Research.RunStatus | "forgotten",
    extra: { sourceID?: string; noteID?: string } = {},
  ) {
    const located = Option.isSome(yield* Effect.serviceOption(Location.Service))
    yield* input.events.publish(
      Research.Updated,
      { runID, status, ...extra },
      located || !place.root ? undefined : { location: { directory: AbsolutePath.make(place.root) } },
    )
  })

  const locate = Effect.fnUntraced(function* (place: Brain.Place, runID: string) {
    const guest = state.guests.has(runID)
    const store = guest ? yield* input.ephemeral : db
    const row = yield* store
      .select()
      .from(ResearchRunTable)
      .where(and(eq(ResearchRunTable.id, runID), eq(ResearchRunTable.repository_id, place.repository)))
      .get()
      .pipe(Effect.orDie)
    return row ? ({ db: store, row, guest } satisfies Found) : undefined
  })

  const sourcesOf = (store: Database, runID: string) =>
    store
      .select()
      .from(ResearchSourceTable)
      .where(eq(ResearchSourceTable.run_id, runID))
      .orderBy(asc(ResearchSourceTable.ordinal))
      .all()
      .pipe(Effect.orDie)

  const notesOf = Effect.fnUntraced(function* (store: Database, runID: string) {
    const rows = yield* store
      .select({ note: ResearchNoteTable, source: ResearchSourceTable.ordinal })
      .from(ResearchNoteTable)
      .innerJoin(ResearchSourceTable, eq(ResearchSourceTable.id, ResearchNoteTable.source_id))
      .where(eq(ResearchNoteTable.run_id, runID))
      .orderBy(asc(ResearchNoteTable.ordinal))
      .all()
      .pipe(Effect.orDie)
    return rows.map((row) => toNote(row.note, row.source))
  })

  const sourceByRef = Effect.fnUntraced(function* (store: Database, runID: string, ref: string) {
    const ordinal = ordinalOf("S", ref)
    if (ordinal === undefined) return undefined
    return yield* store
      .select()
      .from(ResearchSourceTable)
      .where(and(eq(ResearchSourceTable.run_id, runID), eq(ResearchSourceTable.ordinal, ordinal)))
      .get()
      .pipe(Effect.orDie)
  })

  const chunksOf = Effect.fnUntraced(function* (store: Database, document: string | null) {
    if (!document) return [] as (ResearchQuote.Part & { readonly passage: string })[]
    const rows = yield* store
      .select({
        id: BrainPassageTable.id,
        body: BrainPassageTable.body,
        ordinal: BrainPassageTable.ordinal,
        page: BrainPassageTable.page,
      })
      .from(BrainPassageTable)
      .where(eq(BrainPassageTable.document_id, document))
      .orderBy(asc(BrainPassageTable.ordinal))
      .all()
      .pipe(Effect.orDie)
    return rows.map((row) => ({
      text: row.body,
      chunk: row.ordinal,
      passage: row.id,
      ...(row.page === null ? {} : { page: row.page }),
    }))
  })

  const bytesOf = Effect.fnUntraced(function* (store: Database, runID: string) {
    const row = yield* store
      .select({ bytes: sql<number | null>`sum(${BrainDocumentTable.bytes})` })
      .from(BrainDocumentTable)
      .where(eq(BrainDocumentTable.run_id, runID))
      .get()
      .pipe(Effect.orDie)
    return row?.bytes ?? 0
  })

  // Whether the user kept the run, or approved its report where held content waits.
  const keptOf = Effect.fnUntraced(function* (store: Database, row: RunRow) {
    if (row.kept) return true
    if (!row.report_document_id) return false
    const document = yield* store
      .select({ status: BrainDocumentTable.status })
      .from(BrainDocumentTable)
      .where(eq(BrainDocumentTable.id, row.report_document_id))
      .get()
      .pipe(Effect.orDie)
    return !!document && BrainKnowledge.USABLE.includes(document.status)
  })

  const runOf = Effect.fnUntraced(function* (store: Database, runID: string) {
    const row = yield* store
      .select()
      .from(ResearchRunTable)
      .where(eq(ResearchRunTable.id, runID))
      .get()
      .pipe(Effect.orDie)
    return row ? toRun(row, yield* keptOf(store, row)) : undefined
  })

  const touch = (store: Database, runID: string, set: Partial<typeof ResearchRunTable.$inferInsert>) =>
    store
      .update(ResearchRunTable)
      .set({ ...set, updated_at: Date.now() })
      .where(eq(ResearchRunTable.id, runID))
      .run()
      .pipe(Effect.orDie)

  // --- Runs -------------------------------------------------------------------------------------------------------

  const start = Effect.fn("ResearchStore.start")(function* (place: Brain.Place, request: StartInput) {
    if (!request.guest) yield* sweepDue()
    const store = request.guest ? yield* input.ephemeral : db
    const now = Date.now()
    const id = `run_${BrainStructure.base32(randomBytes(8))}`
    const plan = request.plan
    yield* store
      .insert(ResearchRunTable)
      .values({
        id,
        repository_id: place.repository,
        session_id: request.sessionID,
        question: BrainCard.clip(BrainScan.stripHidden(plan?.question ?? request.question), 1_000),
        plan: plan ?? null,
        depth: plan?.depth ?? request.depth,
        scope: plan?.scope ?? request.scope,
        status: "planned",
        queries: [],
        limits: request.budget ? { ...request.budget } : null,
        created_at: now,
        updated_at: now,
      })
      .run()
      .pipe(Effect.orDie)
    if (request.guest) state.guests.add(id)
    yield* publish(place, id, "planned")
    return (yield* runOf(store, id))!
  })

  const active = Effect.fn("ResearchStore.active")(function* (place: Brain.Place, sessionID: string) {
    const pick = (store: Database) =>
      store
        .select()
        .from(ResearchRunTable)
        .where(
          and(
            eq(ResearchRunTable.repository_id, place.repository),
            eq(ResearchRunTable.session_id, sessionID),
            inArray(ResearchRunTable.status, ["planned", "running"]),
          ),
        )
        .orderBy(desc(ResearchRunTable.created_at))
        .get()
        .pipe(Effect.orDie)
    const guest = state.guests.size > 0 ? yield* pick(yield* input.ephemeral) : undefined
    if (guest) return toRun(guest, false)
    const row = yield* pick(db)
    return row ? toRun(row, yield* keptOf(db, row)) : undefined
  })

  const plan = Effect.fn("ResearchStore.plan")(function* (
    place: Brain.Place,
    runID: string,
    next: Research.Plan,
    status?: Research.RunStatus,
  ) {
    const found = yield* locate(place, runID)
    if (!found) return undefined
    yield* touch(found.db, runID, {
      plan: next,
      question: BrainCard.clip(BrainScan.stripHidden(next.question), 1_000),
      depth: next.depth,
      scope: next.scope,
      ...(status ? { status } : {}),
    })
    yield* publish(place, runID, status ?? found.row.status)
    return yield* runOf(found.db, runID)
  })

  const setStatus = Effect.fn("ResearchStore.status")(function* (
    place: Brain.Place,
    runID: string,
    status: Research.RunStatus,
  ) {
    const found = yield* locate(place, runID)
    if (!found) return undefined
    yield* touch(found.db, runID, { status })
    yield* publish(place, runID, status)
    return yield* runOf(found.db, runID)
  })

  const count = Effect.fn("ResearchStore.count")(function* (
    place: Brain.Place,
    runID: string,
    change: { readonly steps?: number; readonly cost?: number },
  ) {
    const found = yield* locate(place, runID)
    if (!found) return undefined
    yield* found.db
      .update(ResearchRunTable)
      .set({
        steps: sql`${ResearchRunTable.steps} + ${Math.max(0, Math.floor(change.steps ?? 0))}`,
        cost_usd: sql`${ResearchRunTable.cost_usd} + ${Math.max(0, change.cost ?? 0)}`,
        updated_at: Date.now(),
      })
      .where(eq(ResearchRunTable.id, runID))
      .run()
      .pipe(Effect.orDie)
    return yield* runOf(found.db, runID)
  })

  const searched = Effect.fn("ResearchStore.searched")(function* (place: Brain.Place, runID: string, query: string) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const found = yield* locate(place, runID)
        if (!found) return { type: "refused" as const, message: NO_RUN }
        const budget = found.row.limits?.searches
        if (budget !== undefined && found.row.searches >= budget) return { type: "refused" as const, message: SEARCHES }
        yield* touch(found.db, runID, {
          searches: found.row.searches + 1,
          queries: [...found.row.queries, BrainCard.clip(query, 200)],
        })
        return { type: "counted" as const, searches: found.row.searches + 1 }
      }),
    )
  })

  // --- Sources ----------------------------------------------------------------------------------------------------

  const addSource = Effect.fn("ResearchStore.addSource")(function* (
    place: Brain.Place,
    runID: string,
    page: SourceInput,
  ) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const found = yield* locate(place, runID)
        if (!found) return { type: "refused" as const, message: NO_RUN }
        const store = found.db
        const sources = yield* sourcesOf(store, runID)
        const text = page.chunks.map((chunk) => chunk.text).join("\n\n")
        const readable = (page.status === "read" || page.status === "paywalled") && text.trim().length > 0
        // An address the run read is free to read again. One it read with no text (skipped, failed, built by script) is
        // filled in, as the same S#, by a later read that has text, such as the desktop browser's. A page read signed in,
        // in the user's own browser after a handoff, is a source of its own both ways round: the run's public copy of the
        // address (a paywall's excerpt, or what the page showed before the sign-in) is not what the user unlocked, and a
        // later public read of the address, a researcher's say, is not the signed-in copy and is never answered with it.
        const signedIn = page.signals?.signed_in === true
        const same = sources.find(
          (source) => source.canonical_url === page.canonical && (source.signals?.signed_in === true) === signedIn,
        )
        const blank =
          same !== undefined && same.document_id === null && !forgottenOf(same) && same.status !== "duplicate"
        if (same && !(blank && readable)) return { type: "known" as const, source: toSource(same) }
        if (!same && sources.length >= limits.sources)
          return {
            type: "refused" as const,
            message: `This run has ${limits.sources} sources, the most one run keeps: write the report from what you have.`,
          }
        const budget = found.row.limits?.pages
        if (readable && budget !== undefined && found.row.pages >= budget)
          return { type: "refused" as const, message: PAGES }
        const ordinal = same?.ordinal ?? (sources.at(-1)?.ordinal ?? 0) + 1
        const row = (extra: Partial<SourceRow>): typeof ResearchSourceTable.$inferInsert => ({
          id: `src_${BrainStructure.base32(randomBytes(8))}`,
          run_id: runID,
          ordinal,
          url: page.url,
          canonical_url: page.canonical,
          title: BrainCard.clip(BrainScan.stripHidden(page.title), 300),
          site: page.site,
          author: page.meta?.author ?? page.signals?.author ?? null,
          published_at: page.meta?.published ?? page.signals?.published ?? null,
          kind: page.signals?.kind ?? "other",
          status: page.status,
          reason: page.reason ?? null,
          signals: page.signals ?? null,
          private: page.private ?? false,
          pages: page.pages ?? null,
          fetched_at: page.fetchedAt ?? Date.now(),
          created_at: Date.now(),
          ...extra,
        })
        const insert = Effect.fnUntraced(function* (values: typeof ResearchSourceTable.$inferInsert) {
          const id = same?.id ?? values.id
          if (same)
            yield* store
              .update(ResearchSourceTable)
              .set({ ...values, id, ordinal: same.ordinal, created_at: same.created_at })
              .where(eq(ResearchSourceTable.id, id))
              .run()
              .pipe(Effect.orDie)
          else yield* store.insert(ResearchSourceTable).values(values).run().pipe(Effect.orDie)
          return toSource(
            (yield* store
              .select()
              .from(ResearchSourceTable)
              .where(eq(ResearchSourceTable.id, id))
              .get()
              .pipe(Effect.orDie))!,
          )
        })
        // Skipped pages (robots.txt, built by script, failed) are kept as a line in Sources and the Method, with no text.
        if (!readable) {
          const source = yield* insert(row({}))
          yield* publish(place, runID, found.row.status, { sourceID: source.id })
          return { type: "added" as const, source }
        }
        const fingerprint = page.fingerprint ?? ResearchDedupe.fingerprint(text)
        const tombstones = [tombstone("url", page.canonical), tombstone("text", fingerprint.hash)]
        const forgotten = found.guest
          ? []
          : yield* db
              .select({ hash: BrainTombstoneTable.norm_hash })
              .from(BrainTombstoneTable)
              .where(
                and(
                  eq(BrainTombstoneTable.repository_id, place.repository),
                  inArray(BrainTombstoneTable.norm_hash, tombstones),
                  sql`${BrainTombstoneTable.until} > ${Date.now()}`,
                ),
              )
              .all()
              .pipe(Effect.orDie)
        if (forgotten.length > 0) {
          const source = yield* insert(row({ status: "failed", reason: FORGOTTEN, signals: null }))
          yield* publish(place, runID, found.row.status, { sourceID: source.id })
          return { type: "added" as const, source }
        }
        // The public copy of a page read signed in holds its excerpt, so it is no source the signed-in read copies. And a
        // public read copies no private source: it is public text of its own, which an agent that may not see the
        // private one (a researcher) can still read and cite.
        const hidden = new Set(
          sources
            .filter((source) => source.private || source.signals?.signed_in === true)
            .map((source) => `S${source.ordinal}`),
        )
        const copy = ResearchDedupe.duplicateOf(
          { ...fingerprint, canonical: page.canonical },
          (yield* knownOf(store, runID, sources)).filter((known) =>
            signedIn ? known.canonical !== page.canonical : page.private === true || !hidden.has(known.id),
          ),
        )
        if (copy) {
          const of = `S${ordinalOf("S", copy) ?? ""}`
          const source = yield* insert(
            row({
              status: "duplicate",
              duplicate_of: of,
              signals: page.signals ? { ...page.signals, duplicate_of: of } : null,
            }),
          )
          yield* publish(place, runID, found.row.status, { sourceID: source.id })
          return { type: "duplicate" as const, source, of }
        }
        const bytes = Buffer.byteLength(text)
        if ((yield* bytesOf(store, runID)) + bytes > limits.bytes)
          return {
            type: "refused" as const,
            message: `This run holds ${Math.round(limits.bytes / 1024 / 1024)} MB of page text, the most one run keeps: write the report from what you have.`,
          }
        const room = found.guest ? { evicted: [] } : yield* roomFor(place, runID, bytes)
        if (room.evicted === undefined) return { type: "refused" as const, message: room.message }
        const document = `d${BrainStructure.base32(randomBytes(5))}`
        const lineage = `research:${runID}:S${ordinal}`
        const header = BrainCard.clip(BrainScan.stripHidden(page.title), 120) || page.site
        // Where each chunk starts in the page's text, its chunks joined by blank lines.
        const starts = BrainStructure.starts(
          page.chunks.map((chunk) => chunk.text.length + 1),
          0,
        )
        yield* write(
          store,
          place.repository,
          {
            id: document,
            origin: "web",
            runID,
            sessionID: found.row.session_id,
            lineage,
            version: 1,
            name: page.canonical.slice(0, 120),
            title: BrainCard.clip(header, 80),
            format: formatOf(page.format),
            hash: fingerprint.hash,
            bytes,
            tokens: Token.estimate(text),
            ...(page.pages === undefined ? {} : { pages: page.pages }),
            sourceUrl: page.canonical,
            fetchedAt: page.fetchedAt ?? Date.now(),
            sections: [
              {
                id: `s${BrainStructure.base32(BrainStructure.sha256(`${document}\0${0}`)).slice(0, BrainStructure.ID)}`,
                ordinal: 0,
                level: 0,
                heading: "",
                path: "",
                tokens: Token.estimate(text),
              },
            ],
            passages: page.chunks.map((chunk, index) => ({
              id: `p${BrainStructure.base32(BrainStructure.sha256(`${place.repository}\0${lineage}\0${chunk.chunk}\0${BrainStructure.normalise(chunk.text)}`)).slice(0, BrainStructure.ID)}`,
              section: 0,
              ordinal: chunk.chunk,
              ...(chunk.page === undefined ? {} : { page: chunk.page }),
              header: chunk.page === undefined ? header : `${header} (p.${chunk.page})`,
              body: chunk.text,
              tokens: Token.estimate(chunk.text),
              start: starts[index]!,
              end: starts[index]! + chunk.text.length,
              normHash: BrainStructure.normHash(chunk.text),
              hold: "web" as const,
            })),
          },
          { index: !found.guest },
        )
        const source = yield* insert(row({ document_id: document }))
        yield* touch(store, runID, {
          pages: found.row.pages + 1,
          status: found.row.status === "planned" ? "running" : found.row.status,
        })
        fingerprinted(runID, [
          ...(state.fingerprints.get(runID) ?? []),
          { ...fingerprint, id: source.id, canonical: page.canonical },
        ])
        yield* publish(place, runID, found.row.status === "planned" ? "running" : found.row.status, {
          sourceID: source.id,
        })
        return { type: "added" as const, source, ...(room.evicted.length > 0 ? { evicted: room.evicted } : {}) }
      }),
    )
  })

  // The run's read pages as dedupe compares them: from the cache, or from their saved text.
  const knownOf = Effect.fnUntraced(function* (store: Database, runID: string, sources: readonly SourceRow[]) {
    const cached = state.fingerprints.get(runID)
    if (cached) return fingerprinted(runID, cached)
    const known = yield* Effect.forEach(
      sources.filter((source) => source.document_id !== null),
      (source) =>
        chunksOf(store, source.document_id).pipe(
          Effect.map((chunks) => ({
            ...ResearchDedupe.fingerprint(chunks.map((chunk) => chunk.text).join("\n\n")),
            id: `S${source.ordinal}`,
            canonical: source.canonical_url,
          })),
        ),
    )
    return fingerprinted(runID, known)
  })

  // Kept for the runs used last only, so finished runs do not hold their pages' shingles for the life of the process.
  const fingerprinted = (runID: string, known: ResearchDedupe.Known[]) => {
    state.fingerprints.delete(runID)
    state.fingerprints.set(runID, known)
    if (state.fingerprints.size > FINGERPRINTED) state.fingerprints.delete(state.fingerprints.keys().next().value!)
    return known
  }

  // Room for `bytes` more in the repository's research: the oldest runs nobody kept go first, never this one.
  const roomFor = Effect.fnUntraced(function* (place: Brain.Place, runID: string, bytes: number) {
    const total = Effect.fnUntraced(function* () {
      const row = yield* db
        .select({ bytes: sql<number | null>`sum(${BrainDocumentTable.bytes})` })
        .from(BrainDocumentTable)
        .where(and(eq(BrainDocumentTable.repository_id, place.repository), isNotNull(BrainDocumentTable.run_id)))
        .get()
        .pipe(Effect.orDie)
      return row?.bytes ?? 0
    })
    const evicted: string[] = []
    if ((yield* total()) + bytes <= limits.repository) return { evicted }
    // Oldest first; runs started in the same millisecond in the order they were started.
    const runs = yield* db
      .select()
      .from(ResearchRunTable)
      .where(eq(ResearchRunTable.repository_id, place.repository))
      .orderBy(asc(ResearchRunTable.created_at), sql`rowid`)
      .all()
      .pipe(Effect.orDie)
    for (const run of runs) {
      if (run.id === runID || (yield* keptOf(db, run))) continue
      yield* drop(place, run.id, { tombstones: false })
      evicted.push(run.id)
      if ((yield* total()) + bytes <= limits.repository) return { evicted }
    }
    return {
      evicted: undefined,
      message: `Research in this repository holds ${Math.round(limits.repository / 1024 / 1024)} MB, the most Vector keeps, and the older runs are ones you kept. Forget some runs to read more.`,
    }
  })

  const source = Effect.fn("ResearchStore.source")(function* (place: Brain.Place, runID: string, ref: string) {
    const found = yield* locate(place, runID)
    if (!found) return undefined
    const row = yield* sourceByRef(found.db, runID, ref)
    if (!row) return undefined
    const chunks = yield* chunksOf(found.db, row.document_id)
    return {
      source: toSource(row),
      chunks: chunks.map((chunk) => ({
        text: chunk.text,
        chunk: chunk.chunk,
        ...(chunk.page === undefined ? {} : { page: chunk.page }),
      })),
      private: row.private,
      forgotten: forgottenOf(row),
    } satisfies Saved
  })

  const focus = Effect.fn("ResearchStore.focus")(function* (
    place: Brain.Place,
    runID: string,
    ref: string,
    query: string,
    limit = 3,
  ) {
    const saved = yield* source(place, runID, ref)
    if (!saved) return []
    const byChunk = new Map(saved.chunks.map((chunk) => [String(chunk.chunk), chunk]))
    return BrainLexical.rank(
      saved.chunks.map((chunk) => ({ id: String(chunk.chunk), terms: BrainLexical.terms(chunk.text) })),
      BrainLexical.terms(query),
    )
      .slice(0, limit)
      .map((hit) => byChunk.get(hit.id)!)
  })

  const quoted = Effect.fn("ResearchStore.quoted")(function* (
    place: Brain.Place,
    runID: string,
    ref: string,
    quote: string,
  ) {
    const found = yield* locate(place, runID)
    if (!found) return { ok: false as const, reason: "no-source" as const, message: NO_RUN }
    const row = yield* sourceByRef(found.db, runID, ref)
    if (!row) return { ok: false as const, reason: "no-source" as const, message: `There is no ${ref} in this run.` }
    return yield* quotedIn(found.db, row, quote)
  })

  const quotedIn = Effect.fnUntraced(function* (store: Database, row: SourceRow, quote: string, page?: number) {
    const id = `S${row.ordinal}`
    if (!row.document_id)
      return {
        ok: false as const,
        reason: "no-source" as const,
        message: forgottenOf(row)
          ? `${id} was forgotten, so its text is gone.`
          : `${id} has no saved text (${row.status === "duplicate" ? `it is a copy of ${row.duplicate_of}` : "it was skipped"}).`,
      }
    const chunks = (yield* chunksOf(store, row.document_id)).filter(
      (chunk) => page === undefined || chunk.page === page,
    )
    const found = ResearchQuote.found({ source: id, parts: chunks, quote })
    if (!found.ok && page !== undefined)
      return {
        ok: false as const,
        reason: "missing" as const,
        message: "That quote was not found on the supplied source page. Use its actual page or omit page.",
      }
    if (!found.ok) return found
    return { ...found, passage: chunks.find((chunk) => chunk.chunk === found.chunk)?.passage } satisfies Quoted
  })

  // --- Notes ------------------------------------------------------------------------------------------------------

  const note = Effect.fn("ResearchStore.note")(function* (place: Brain.Place, runID: string, request: NoteInput) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const found = yield* locate(place, runID)
        if (!found) return { type: "refused" as const, message: NO_RUN }
        const claim = request.claim.trim()
        const subquestion = request.subquestion.trim()
        if (!claim || claim.length > 400)
          return { type: "refused" as const, message: "A claim is 1 to 400 characters." }
        if (!subquestion || subquestion.length > 300)
          return {
            type: "refused" as const,
            message: "Name the sub-question the note answers, in at most 300 characters.",
          }
        if (request.quote.length > 600)
          return { type: "refused" as const, message: "A quote is at most 600 characters." }
        const row = yield* sourceByRef(found.db, runID, request.source)
        if (!row) return { type: "refused" as const, message: `There is no ${request.source} in this run.` }
        const checked = yield* quotedIn(found.db, row, request.quote, request.page)
        if (!checked.ok) return { type: "refused" as const, message: checked.message }
        const invalidMeasurement = request.measurement && ResearchClaim.check(request.measurement, checked.quote)
        if (invalidMeasurement) return { type: "refused" as const, message: invalidMeasurement }
        const last = yield* found.db
          .select({ ordinal: sql<number | null>`max(${ResearchNoteTable.ordinal})` })
          .from(ResearchNoteTable)
          .where(eq(ResearchNoteTable.run_id, runID))
          .get()
          .pipe(Effect.orDie)
        const values = {
          id: `note_${BrainStructure.base32(randomBytes(8))}`,
          run_id: runID,
          ordinal: (last?.ordinal ?? 0) + 1,
          subquestion,
          claim,
          source_id: row.id,
          passage_id: checked.passage ?? null,
          // The source's own words, so the report shows what the source says, not the agent's copy of it.
          quote: checked.quote,
          page: request.page ?? checked.page ?? null,
          stance: request.stance ?? ("supports" as const),
          support: ResearchQuote.supports(claim, checked.quote),
          verdict: null,
          measurement: request.measurement ? Schema.decodeUnknownSync(Research.Measurement)(request.measurement) : null,
          created_at: Date.now(),
        } satisfies typeof ResearchNoteTable.$inferInsert
        yield* found.db.insert(ResearchNoteTable).values(values).run().pipe(Effect.orDie)
        yield* touch(found.db, runID, {})
        if (!found.guest) yield* wake()
        const saved = toNote(values, row.ordinal)
        yield* publish(place, runID, found.row.status, { noteID: saved.id })
        const comparisonSources = request.measurement
          ? (yield* sourcesOf(found.db, runID))
              .filter(
                (item) =>
                  item.document_id !== null &&
                  (!request.publicOnly || (!item.private && item.signals?.signed_in !== true)),
              )
              .map(toSource)
          : []
        const allowed = new Set(comparisonSources.map((item) => item.id))
        const comparisons = request.measurement
          ? ResearchClaim.comparisons(
              [
                saved,
                ...(yield* notesOf(found.db, runID)).filter((item) => item.id !== saved.id && allowed.has(item.source)),
              ],
              comparisonSources,
            ).filter((item) => item.left === saved.id || item.right === saved.id)
          : []
        return { type: "saved" as const, note: saved, ...(comparisons.length ? { comparisons } : {}) }
      }),
    )
  })

  const judged = Effect.fn("ResearchStore.judged")(function* (
    place: Brain.Place,
    runID: string,
    verdicts: readonly { readonly note: string; readonly verdict: Research.Verdict }[],
  ) {
    const found = yield* locate(place, runID)
    if (!found) return 0
    const changed = yield* Effect.forEach(verdicts, (item) => {
      const ordinal = ordinalOf("N", item.note)
      if (ordinal === undefined) return Effect.succeed(0)
      return found.db
        .update(ResearchNoteTable)
        .set({ verdict: item.verdict })
        .where(and(eq(ResearchNoteTable.run_id, runID), eq(ResearchNoteTable.ordinal, ordinal)))
        .returning({ id: ResearchNoteTable.id })
        .all()
        .pipe(
          Effect.orDie,
          Effect.map((rows) => rows.length),
        )
    })
    yield* touch(found.db, runID, {})
    yield* publish(place, runID, found.row.status)
    return changed.reduce((sum, value) => sum + value, 0)
  })

  // --- Reports ----------------------------------------------------------------------------------------------------

  const report = Effect.fn("ResearchStore.report")(function* (
    place: Brain.Place,
    runID: string,
    request: Research.ReportInput,
    options: ReportOptions = {},
  ) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const found = yield* locate(place, runID)
        if (!found) return { type: "refused" as const, errors: [NO_RUN], uncited: [] }
        const notes = yield* notesOf(found.db, runID)
        const rows = yield* sourcesOf(found.db, runID)
        const problems = ResearchReport.check(request, {
          notes,
          ...(found.row.plan ? { plan: found.row.plan } : {}),
        })
        if (problems.errors.length > 0)
          return { type: "refused" as const, errors: problems.errors, uncited: problems.uncited }
        // Each quote is checked again: its source may have been forgotten since the note was saved.
        const unverified = new Set<string>()
        for (const item of notes) {
          const row = rows.find((source) => `S${source.ordinal}` === item.source)
          const again = row ? yield* quotedIn(found.db, row, item.quote) : undefined
          if (!again?.ok) unverified.add(item.id)
        }
        const rendered = ResearchReport.render(request, {
          notes,
          sources: rows.map(toSource),
          judged: options.judged ?? false,
          unverified,
          method: {
            searches: found.row.searches,
            pages: found.row.pages,
            queries: found.row.queries,
            ...(options.spend ? { spend: options.spend } : {}),
            ...(options.seconds === undefined ? {} : { seconds: options.seconds }),
          },
        })
        const version = found.row.report_document_id
          ? ((yield* found.db
              .select({ version: BrainDocumentTable.version })
              .from(BrainDocumentTable)
              .where(eq(BrainDocumentTable.id, found.row.report_document_id))
              .get()
              .pipe(Effect.orDie))?.version ?? 0) + 1
          : 1
        const bytes = Buffer.byteLength(rendered.markdown)
        const room = found.guest ? { evicted: [] } : yield* roomFor(place, runID, bytes)
        if (room.evicted === undefined)
          return { type: "refused" as const, errors: [room.message], uncited: problems.uncited }
        const previous = found.row.report_document_id
        // Only the latest version is kept: a new one is held again until the user keeps it.
        if (previous) yield* removeDocuments(place, found, [previous])
        const document = yield* writeReport(
          found,
          place.repository,
          request.title,
          rendered.markdown,
          version,
          previous ?? undefined,
        )
        yield* touch(found.db, runID, {
          report_document_id: document,
          report: rendered.markdown,
          status: "done",
          kept: false,
        })
        if (!found.guest) yield* wake()
        yield* publish(place, runID, "done")
        return {
          type: "saved" as const,
          rendered,
          ...(found.guest ? {} : { document }),
          version,
          uncited: problems.uncited,
        }
      }),
    )
  })

  const writeReport = Effect.fnUntraced(function* (
    found: Found,
    repository: string,
    title: string,
    markdown: string,
    version: number,
    previous: string | undefined,
  ) {
    const id = `d${BrainStructure.base32(randomBytes(5))}`
    const lineage = `research:${found.row.id}:report`
    const limits = BrainLimits.LIMITS.inline
    const extracted = yield* Effect.promise(() =>
      BrainDocument.read({ name: "report.md", bytes: new TextEncoder().encode(markdown) }, limits),
    )
    const structured =
      extracted.type === "extracted"
        ? BrainStructure.structure(extracted, { repository, lineage, document: id, limits })
        : undefined
    yield* write(
      found.db,
      repository,
      {
        id,
        origin: "research",
        runID: found.row.id,
        sessionID: found.row.session_id,
        lineage,
        version,
        ...(previous ? { previous } : {}),
        name: `research-${found.row.id}.md`,
        title: BrainCard.clip(BrainScan.stripHidden(title), 80) || "Research report",
        format: "markdown",
        hash: createHash("sha256").update(markdown).digest("hex"),
        bytes: Buffer.byteLength(markdown),
        tokens: Token.estimate(markdown),
        sections: (structured?.sections ?? []).map((section) => ({
          id: section.id,
          ordinal: section.ordinal,
          ...(section.parent === undefined ? {} : { parent: section.parent }),
          level: section.level,
          heading: section.heading,
          path: section.path,
          ...(section.pageStart === undefined ? {} : { pageStart: section.pageStart }),
          ...(section.pageEnd === undefined ? {} : { pageEnd: section.pageEnd }),
          tokens: section.tokens,
        })),
        passages: (structured?.passages ?? []).map((passage) => ({
          id: passage.id,
          section: passage.section,
          ordinal: passage.ordinal,
          ...(passage.page === undefined ? {} : { page: passage.page }),
          header: passage.header,
          body: passage.body,
          tokens: passage.tokens,
          start: passage.start,
          end: passage.end,
          normHash: passage.normHash,
          ...(passage.hold ? { hold: passage.hold } : {}),
        })),
      },
      { index: !found.guest },
    )
    return id
  })

  // --- Reading runs -----------------------------------------------------------------------------------------------

  const summaryOf = Effect.fnUntraced(function* (store: Database, row: RunRow) {
    const counts = yield* store
      .get<{ sources: number; notes: number }>(
        sql`SELECT (SELECT count(*) FROM ${ResearchSourceTable} WHERE ${ResearchSourceTable.run_id} = ${row.id}) AS sources,
              (SELECT count(*) FROM ${ResearchNoteTable} WHERE ${ResearchNoteTable.run_id} = ${row.id}) AS notes`,
      )
      .pipe(Effect.orDie)
    return {
      run: toRun(row, yield* keptOf(store, row)),
      sources: counts?.sources ?? 0,
      notes: counts?.notes ?? 0,
      bytes: yield* bytesOf(store, row.id),
    } satisfies Summary
  })

  const get = Effect.fn("ResearchStore.get")(function* (place: Brain.Place, runID: string) {
    const found = yield* locate(place, runID)
    if (!found) return undefined
    const rows = yield* sourcesOf(found.db, runID)
    return {
      run: toRun(found.row, yield* keptOf(found.db, found.row)),
      sources: rows.map((row) => ({ ...toSource(row), ...(forgottenOf(row) ? { forgotten: true } : {}) })),
      notes: yield* notesOf(found.db, runID),
      queries: found.row.queries,
      ...(found.row.report ? { report: found.row.report } : {}),
      bytes: yield* bytesOf(found.db, runID),
      guest: found.guest,
    } satisfies Detail
  })

  const list = Effect.fn("ResearchStore.list")(function* (place: Brain.Place) {
    yield* sweepDue()
    const rows = yield* db
      .select()
      .from(ResearchRunTable)
      .where(eq(ResearchRunTable.repository_id, place.repository))
      .orderBy(desc(ResearchRunTable.created_at), sql`rowid DESC`)
      .all()
      .pipe(Effect.orDie)
    return yield* Effect.forEach(rows, (row) => summaryOf(db, row))
  })

  // --- Keeping and forgetting -------------------------------------------------------------------------------------

  const keep = Effect.fn("ResearchStore.keep")(function* (place: Brain.Place, runID: string) {
    const found = yield* locate(place, runID)
    if (!found) return undefined
    if (found.guest) return { type: "refused" as const, message: GUEST }
    yield* touch(db, runID, { kept: true })
    if (found.row.report_document_id)
      yield* knowledge.update(place, found.row.report_document_id, { action: "approve" })
    yield* publish(place, runID, found.row.status)
    return { type: "kept" as const, run: (yield* runOf(db, runID))! }
  })

  // Documents of a run, gone with everything read from them. A report may have been kept, recalled, cited and learned
  // from, so the knowledge store forgets it, uses, links and cached cards included. A page was held whole and passage by
  // passage, so nothing used, cited or linked it: its rows go at once (sections, passages, postings and vectors go with
  // it), and the keyword index is counted again once. The memory brain holds nothing else.
  const removeDocuments = Effect.fnUntraced(function* (
    place: Brain.Place,
    found: Pick<Found, "db" | "guest">,
    ids: readonly string[],
  ) {
    if (ids.length === 0) return
    if (found.guest)
      return yield* found.db
        .delete(BrainDocumentTable)
        .where(inArray(BrainDocumentTable.id, [...ids]))
        .run()
        .pipe(Effect.orDie)
    const rows = yield* db
      .select({ id: BrainDocumentTable.id, origin: BrainDocumentTable.origin })
      .from(BrainDocumentTable)
      .where(and(eq(BrainDocumentTable.repository_id, place.repository), inArray(BrainDocumentTable.id, [...ids])))
      .all()
      .pipe(Effect.orDie)
    yield* Effect.forEach(
      rows.filter((row) => row.origin === "research"),
      (row) => knowledge.remove(place, row.id),
      { discard: true },
    )
    const pages = rows.filter((row) => row.origin === "web").map((row) => row.id)
    if (pages.length === 0) return
    const terms = yield* db
      .selectDistinct({ term: BrainPostingTable.term })
      .from(BrainPostingTable)
      .innerJoin(BrainItemTable, eq(BrainItemTable.id, BrainPostingTable.item))
      .where(inArray(BrainItemTable.document_id, pages))
      .all()
      .pipe(Effect.orDie)
    for (const batch of chunks(pages, 500))
      yield* db.delete(BrainDocumentTable).where(inArray(BrainDocumentTable.id, batch)).run().pipe(Effect.orDie)
    yield* frequencies(
      db,
      place.repository,
      terms.map((row) => row.term),
    )
    yield* totals(db, place.repository)
  })

  const tombstoneSources = Effect.fnUntraced(function* (place: Brain.Place, rows: readonly SourceRow[]) {
    const now = Date.now()
    const hashes = yield* Effect.forEach(
      rows.filter((row) => row.document_id !== null),
      (row) =>
        db
          .select({ hash: BrainDocumentTable.content_hash })
          .from(BrainDocumentTable)
          .where(eq(BrainDocumentTable.id, row.document_id!))
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((document) => [
              tombstone("url", row.canonical_url),
              ...(document ? [tombstone("text", document.hash)] : []),
            ]),
          ),
    )
    for (const hash of [...new Set(hashes.flat())])
      yield* db
        .insert(BrainTombstoneTable)
        .values({ repository_id: place.repository, norm_hash: hash, until: now + TOMBSTONE })
        .onConflictDoUpdate({
          target: [BrainTombstoneTable.repository_id, BrainTombstoneTable.norm_hash],
          set: { until: now + TOMBSTONE },
        })
        .run()
        .pipe(Effect.orDie)
  })

  // A run and everything it holds. The user's Forget leaves tombstones for its pages; the retention sweep and the
  // repository cap leave only the tombstones every forgotten document leaves, so a later run may read those pages again.
  const drop = Effect.fnUntraced(function* (
    place: Brain.Place,
    runID: string,
    options: { readonly tombstones: boolean },
  ) {
    const found = yield* locate(place, runID)
    if (!found) return false
    if (options.tombstones && !found.guest) yield* tombstoneSources(place, yield* sourcesOf(db, runID))
    const documents = yield* found.db
      .select({ id: BrainDocumentTable.id })
      .from(BrainDocumentTable)
      .where(eq(BrainDocumentTable.run_id, runID))
      .all()
      .pipe(Effect.orDie)
    yield* removeDocuments(
      place,
      found,
      documents.map((document) => document.id),
    )
    yield* found.db.delete(ResearchRunTable).where(eq(ResearchRunTable.id, runID)).run().pipe(Effect.orDie)
    state.guests.delete(runID)
    state.fingerprints.delete(runID)
    yield* publish(place, runID, "forgotten")
    return true
  })

  const forget = Effect.fn("ResearchStore.forget")(function* (place: Brain.Place, runID: string) {
    return yield* lock.withPermit(drop(place, runID, { tombstones: true }))
  })

  const forgetSource = Effect.fn("ResearchStore.forgetSource")(function* (
    place: Brain.Place,
    runID: string,
    ref: string,
  ) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const found = yield* locate(place, runID)
        if (!found) return false
        const row = yield* sourceByRef(found.db, runID, ref)
        if (!row) return false
        if (!found.guest) yield* tombstoneSources(place, [row])
        // The row stays without its page, so its notes can say their quote is no longer in it.
        if (row.document_id) yield* removeDocuments(place, found, [row.document_id])
        yield* touch(found.db, runID, {})
        state.fingerprints.delete(runID)
        yield* publish(place, runID, found.row.status, { sourceID: `S${row.ordinal}` })
        return true
      }),
    )
  })

  const forgetAll = Effect.fn("ResearchStore.forgetAll")(function* (
    place: Brain.Place,
    options: ForgetAllOptions = {},
  ) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const runsOf = (store: Database) =>
          store
            .select({ id: ResearchRunTable.id, repository: ResearchRunTable.repository_id })
            .from(ResearchRunTable)
            .where(
              and(
                options.everywhere ? undefined : eq(ResearchRunTable.repository_id, place.repository),
                options.session === undefined ? undefined : eq(ResearchRunTable.session_id, options.session),
              ),
            )
            .all()
            .pipe(Effect.orDie)
        // Runs a guest acted in go too: their pages are in this process's memory, not the brain, but they are research.
        const rows = [...(yield* runsOf(db)), ...(state.guests.size > 0 ? yield* runsOf(yield* input.ephemeral) : [])]
        const dropped = yield* Effect.forEach(rows, (row) =>
          // Another repository's run has no working tree here, so its event names none rather than this one.
          drop(row.repository === place.repository ? place : rootless(row.repository), row.id, { tombstones: true }),
        )
        return dropped.filter(Boolean).length
      }),
    )
  })

  const sweep = Effect.fn("ResearchStore.sweep")(function* (now = Date.now()) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        state.swept = now
        const cutoff = now - limits.retain * DAY
        const old = yield* db
          .select()
          .from(ResearchRunTable)
          .where(and(eq(ResearchRunTable.kept, false), lt(ResearchRunTable.updated_at, cutoff)))
          .all()
          .pipe(Effect.orDie)
        // A run a guest acted in cannot be kept, and a server with invited guests may run for months: its pages leave
        // this process's memory after the same time.
        const guests =
          state.guests.size > 0
            ? yield* (yield* input.ephemeral)
                .select({ id: ResearchRunTable.id, repository: ResearchRunTable.repository_id })
                .from(ResearchRunTable)
                .where(lt(ResearchRunTable.updated_at, cutoff))
                .all()
                .pipe(Effect.orDie)
            : []
        const swept = yield* Effect.forEach(old, (row) =>
          Effect.gen(function* () {
            if (yield* keptOf(db, row)) return false
            return yield* drop(rootless(row.repository_id), row.id, { tombstones: false })
          }),
        )
        const gone = yield* Effect.forEach(guests, (row) =>
          drop(rootless(row.repository), row.id, { tombstones: false }),
        )
        return [...swept, ...gone].filter(Boolean).length
      }),
    )
  })

  const sweepDue = () =>
    Date.now() - state.swept < SWEEP_EVERY
      ? Effect.void
      : sweep().pipe(
          Effect.asVoid,
          Effect.catchCause((cause) => Effect.logWarning("research retention sweep failed", { cause })),
        )

  // --- Guests -----------------------------------------------------------------------------------------------------

  const guest = Effect.fn("ResearchStore.guest")(function* (place: Brain.Place, runID: string) {
    yield* lock.withPermit(
      Effect.gen(function* () {
        if (state.guests.has(runID)) return
        const found = yield* locate(place, runID)
        if (!found) return
        const memory = yield* input.ephemeral
        const run = found.row
        const sources = yield* sourcesOf(db, runID)
        const notes = yield* db
          .select()
          .from(ResearchNoteTable)
          .where(eq(ResearchNoteTable.run_id, runID))
          .all()
          .pipe(Effect.orDie)
        const documents = yield* db
          .select()
          .from(BrainDocumentTable)
          .where(eq(BrainDocumentTable.run_id, runID))
          .all()
          .pipe(Effect.orDie)
        const ids = documents.map((document) => document.id)
        const sections =
          ids.length === 0
            ? []
            : yield* db
                .select()
                .from(BrainSectionTable)
                .where(inArray(BrainSectionTable.document_id, ids))
                .all()
                .pipe(Effect.orDie)
        const passages =
          ids.length === 0
            ? []
            : yield* db
                .select({ passage: BrainPassageTable, item: BrainItemTable })
                .from(BrainPassageTable)
                .innerJoin(BrainItemTable, eq(BrainItemTable.id, BrainPassageTable.item))
                .where(inArray(BrainPassageTable.document_id, ids))
                .all()
                .pipe(Effect.orDie)
        // Copied into the memory brain first, so nothing is lost if the process stops in between.
        yield* memory
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .insert(ResearchRunTable)
                .values({ ...run, report_document_id: null })
                .run()
              for (const document of documents)
                yield* tx
                  .insert(BrainDocumentTable)
                  .values({
                    ...document,
                    ordinal: sql`(SELECT coalesce(max("ordinal"), 0) + 1 FROM "brain_document" WHERE "repository_id" = ${document.repository_id})`,
                  })
                  .run()
              for (const section of sections) yield* tx.insert(BrainSectionTable).values(section).run()
              for (const row of passages) {
                const { id: _, ...item } = row.item
                const inserted = yield* tx
                  .insert(BrainItemTable)
                  .values(item)
                  .returning({ id: BrainItemTable.id })
                  .get()
                yield* tx
                  .insert(BrainPassageTable)
                  .values({ ...row.passage, item: inserted!.id })
                  .run()
              }
              for (const source of sources) yield* tx.insert(ResearchSourceTable).values(source).run()
              for (const item of notes) yield* tx.insert(ResearchNoteTable).values(item).run()
              if (run.report_document_id)
                yield* tx
                  .update(ResearchRunTable)
                  .set({ report_document_id: run.report_document_id, report: run.report })
                  .where(eq(ResearchRunTable.id, runID))
                  .run()
            }),
          )
          .pipe(Effect.orDie)
        // Then out of the brain, with no tombstones: the owner did not forget these pages.
        yield* removeDocuments(place, { db, guest: false }, ids)
        yield* db.delete(ResearchRunTable).where(eq(ResearchRunTable.id, runID)).run().pipe(Effect.orDie)
        state.guests.add(runID)
        yield* publish(place, runID, run.status)
      }),
    )
  })

  // --- Writing documents ------------------------------------------------------------------------------------------

  const write = Effect.fnUntraced(function* (
    store: Database,
    repository: string,
    document: Written,
    options: { readonly index: boolean },
  ) {
    const now = Date.now()
    const held = document.passages.filter((passage) => passage.hold).length
    const items = document.passages.map((passage) => ({
      passage,
      terms: merge(BrainLexical.terms(passage.body), BrainLexical.terms(passage.header), 2),
    }))
    const ids = yield* store
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* tx
            .insert(BrainDocumentTable)
            .values({
              id: document.id,
              repository_id: repository,
              lineage: document.lineage,
              version: document.version,
              previous_id: document.previous ?? null,
              ordinal: sql`(SELECT coalesce(max("ordinal"), 0) + 1 FROM "brain_document" WHERE "repository_id" = ${repository})`,
              name: document.name,
              title: document.title,
              format: document.format,
              origin: document.origin,
              visibility: "private",
              content_hash: document.hash,
              bytes: document.bytes,
              pages: document.pages ?? null,
              unread: [],
              source_path: null,
              stored: false,
              // Held as a whole until the user keeps it: nothing reads a held document's passages into a request.
              status: "held",
              hold_reason: "web",
              stats: {
                tokens: document.tokens,
                read: document.pages ?? document.sections.length,
                sections: document.sections.length,
                passages: document.passages.length,
                records: 0,
                kinds: Object.fromEntries(
                  BrainSchema.RecordKind.literals.map((kind) => [kind, 0]),
                ) as BrainSchema.DocumentStats["kinds"],
                held,
                linked: 0,
                embedded: 0,
              },
              warnings: [],
              error: null,
              extractor: BrainKnowledge.EXTRACTOR,
              embed_model: null,
              origin_session_id: document.sessionID,
              created_at: now,
              updated_at: now,
              indexed_at: now,
              source_url: document.sourceUrl ?? null,
              fetched_at: document.fetchedAt ?? null,
              run_id: document.runID,
            })
            .run()
          for (const batch of chunks(document.sections, 500))
            yield* tx
              .insert(BrainSectionTable)
              .values(
                batch.map((section) => ({
                  id: section.id,
                  document_id: document.id,
                  parent_id:
                    section.parent === undefined
                      ? null
                      : (document.sections.find((other) => other.ordinal === section.parent)?.id ?? null),
                  ordinal: section.ordinal,
                  level: section.level,
                  heading: section.heading,
                  path: section.path,
                  kind: "section" as const,
                  page_start: section.pageStart ?? null,
                  page_end: section.pageEnd ?? null,
                  tokens: section.tokens,
                })),
              )
              .run()
          const ids = new Map<string, number>()
          for (const item of items) {
            const inserted = yield* tx
              .insert(BrainItemTable)
              .values({
                repository_id: repository,
                type: "passage",
                ref: item.passage.id,
                document_id: document.id,
                visibility: "private",
                // A page's passages are held one by one too, so approving the page alone serves none of them.
                status: item.passage.hold ? "quarantined" : "active",
                hold_reason: item.passage.hold ?? null,
                length: [...item.terms.values()].reduce((sum, value) => sum + value, 0),
                confidence: 1,
              })
              .returning({ id: BrainItemTable.id })
              .get()
            ids.set(item.passage.id, inserted!.id)
          }
          const sectionID = (ordinal: number) =>
            document.sections.find((section) => section.ordinal === ordinal)?.id ?? document.sections[0]?.id ?? ""
          for (const passage of document.passages)
            yield* tx
              .insert(BrainPassageTable)
              .values({
                id: passage.id,
                item: ids.get(passage.id)!,
                document_id: document.id,
                section_id: sectionID(passage.section),
                ordinal: passage.ordinal,
                page: passage.page ?? null,
                header: passage.header,
                body: passage.body,
                tokens: passage.tokens,
                span_start: passage.start,
                span_end: passage.end,
                norm_hash: passage.normHash,
              })
              .run()
          return ids
        }),
      )
      .pipe(Effect.orDie)
    if (!options.index) return
    // The keyword index, at once: postings for each passage, the terms' document frequencies, and BM25's totals.
    const words = [...new Set(items.flatMap((item) => [...item.terms.keys()]))]
    const termIds = new Map<string, number>()
    for (const batch of chunks(words, 500)) {
      yield* store
        .insert(BrainTermTable)
        .values(batch.map((term) => ({ repository_id: repository, term })))
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const rows = yield* store
        .select({ id: BrainTermTable.id, term: BrainTermTable.term })
        .from(BrainTermTable)
        .where(and(eq(BrainTermTable.repository_id, repository), inArray(BrainTermTable.term, batch)))
        .all()
        .pipe(Effect.orDie)
      rows.forEach((row) => termIds.set(row.term, row.id))
    }
    const postings = items.flatMap((item) =>
      [...item.terms].map(([term, count]) => ({ term: termIds.get(term)!, item: ids.get(item.passage.id)!, count })),
    )
    for (const batch of chunks(postings, BrainKnowledge.LIMIT.batch))
      yield* store
        .transaction((tx) =>
          Effect.forEach(chunks(batch, 500), (rows) => tx.insert(BrainPostingTable).values(rows).run(), {
            discard: true,
          }),
        )
        .pipe(Effect.orDie)
    yield* frequencies(store, repository, [...termIds.values()])
    yield* totals(store, repository)
  })

  // Each term's document frequency, counted again for the terms a write or a removal touched, as the knowledge store
  // counts it; terms no item has any more go.
  const frequencies = Effect.fnUntraced(function* (store: Database, repository: string, terms: readonly number[]) {
    for (const batch of chunks(terms, 500)) {
      yield* store
        .update(BrainTermTable)
        .set({
          df: sql`(SELECT count(*) FROM ${BrainPostingTable} WHERE ${BrainPostingTable.term} = ${BrainTermTable.id})`,
        })
        .where(and(eq(BrainTermTable.repository_id, repository), inArray(BrainTermTable.id, batch)))
        .run()
        .pipe(Effect.orDie)
      yield* store
        .delete(BrainTermTable)
        .where(
          and(
            eq(BrainTermTable.repository_id, repository),
            inArray(BrainTermTable.id, batch),
            eq(BrainTermTable.df, 0),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    }
  })

  // BM25's N and total length for the repository, and a new knowledge revision, so cached views read it again.
  const totals = Effect.fnUntraced(function* (store: Database, repository: string) {
    const sums = yield* store
      .select({ items: sql<number>`count(*)`, length: sql<number | null>`sum(${BrainItemTable.length})` })
      .from(BrainItemTable)
      .where(and(eq(BrainItemTable.repository_id, repository), sql`${BrainItemTable.status} != 'archived'`))
      .get()
      .pipe(Effect.orDie)
    yield* store
      .insert(BrainStateTable)
      .values({
        repository_id: repository,
        knowledge_revision: 1,
        items: sums?.items ?? 0,
        item_length_sum: sums?.length ?? 0,
      })
      .onConflictDoUpdate({
        target: BrainStateTable.repository_id,
        set: {
          knowledge_revision: sql`${BrainStateTable.knowledge_revision} + 1`,
          items: sums?.items ?? 0,
          item_length_sum: sums?.length ?? 0,
        },
      })
      .run()
      .pipe(Effect.orDie)
  })

  // --- Vectors when idle ------------------------------------------------------------------------------------------

  // Passages a note quotes, and the passages of reports, that the model in use has no vector for: one at a time.
  const nextVector = Effect.fnUntraced(function* (key: string) {
    return yield* db
      .get<{ item: number; repository: string; header: string; body: string; hash: string }>(
        sql`SELECT i.id AS item, i.repository_id AS repository, p.header AS header, p.body AS body, p.norm_hash AS hash
            FROM ${BrainPassageTable} p
            JOIN ${BrainItemTable} i ON i.id = p.item
            JOIN ${BrainDocumentTable} d ON d.id = p.document_id
            LEFT JOIN ${BrainVectorTable} v ON v.item = i.id
            WHERE d.run_id IS NOT NULL
              AND (d.origin = 'research' OR p.id IN (SELECT ${ResearchNoteTable.passage_id} FROM ${ResearchNoteTable} WHERE ${ResearchNoteTable.passage_id} IS NOT NULL))
              AND (v.item IS NULL OR v.model != ${key} OR v.norm_hash != p.norm_hash)
            ORDER BY i.id
            LIMIT 1`,
      )
      .pipe(Effect.orDie)
  })

  const embedNow = Effect.fn("ResearchStore.embed")(function* () {
    const done = { count: 0 }
    for (;;) {
      const current = yield* input.embed.current()
      if (!current || current.paused) return done.count
      const next = yield* nextVector(current.key)
      if (!next) return done.count
      const started = Date.now()
      const vectors = yield* input.embed.embed([`${next.header}\n${next.body}`])
      const vector = vectors?.[0]
      if (!vector) return done.count
      const quantized = BrainVector.quantize(vector)
      const values = {
        item: next.item,
        repository_id: next.repository,
        model: current.key,
        q8: Buffer.from(quantized.q8.buffer, quantized.q8.byteOffset, quantized.q8.byteLength),
        bits: Buffer.from(quantized.bits),
        scale: quantized.scale,
        norm_hash: next.hash,
        embedded_at: Date.now(),
      }
      yield* db
        .insert(BrainVectorTable)
        .values(values)
        .onConflictDoUpdate({ target: BrainVectorTable.item, set: values })
        .run()
        .pipe(Effect.orDie)
      done.count++
      // Idle work: rest as long as the passage took, so the model's machine stays free for a request.
      yield* Effect.sleep(Date.now() - started)
    }
  })

  // The background embedder, started by the first note or report: woken by each, and looking again every half minute.
  const wake = Effect.fnUntraced(function* () {
    yield* Queue.offer(input.wakeup, undefined)
    if (state.embedder) return
    state.embedder = true
    yield* Effect.gen(function* () {
      for (;;) {
        yield* Queue.take(input.wakeup).pipe(Effect.raceFirst(Effect.sleep(IDLE)))
        yield* embedNow().pipe(Effect.catchCause((cause) => Effect.logWarning("research embedding failed", { cause })))
      }
    }).pipe(Effect.forkIn(input.scope))
  })

  return {
    start,
    active,
    plan,
    status: setStatus,
    count,
    searched,
    addSource,
    source,
    focus,
    quoted,
    note,
    judged,
    report,
    get,
    list,
    keep,
    forget,
    forgetSource,
    forgetAll,
    export: Effect.fn("ResearchStore.export")(function* (
      place: Brain.Place,
      runID: string,
      format: "markdown" | "json",
    ) {
      const detail = yield* get(place, runID)
      if (!detail) return undefined
      const slug =
        detail.run.question
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 60) || "research"
      if (format === "json")
        return {
          name: `research-${slug}.json`,
          type: "application/json",
          body: `${JSON.stringify(
            {
              run: detail.run,
              queries: detail.queries,
              sources: detail.sources,
              notes: detail.notes,
              ...(detail.report ? { report: detail.report } : {}),
            },
            null,
            2,
          )}\n`,
        } satisfies Exported
      return { name: `research-${slug}.md`, type: "text/markdown", body: markdownOf(detail) } satisfies Exported
    }),
    guest,
    sweep,
    embed: embedNow,
  }
}

function toRun(row: RunRow, kept: boolean): Research.Run {
  return {
    id: row.id,
    session_id: row.session_id,
    question: row.question,
    ...(row.plan ? { plan: row.plan } : {}),
    depth: row.depth,
    scope: row.scope,
    status: row.status,
    ...(row.report_document_id ? { report_document_id: row.report_document_id } : {}),
    pages: row.pages,
    searches: row.searches,
    steps: row.steps,
    cost_usd: row.cost_usd,
    kept,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function toSource(row: SourceRow): Research.Source {
  return {
    id: `S${row.ordinal}`,
    url: row.url,
    canonical_url: row.canonical_url,
    title: row.title,
    site: row.site,
    status: row.status,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.pages ? { pages: row.pages } : {}),
    ...(row.signals ? { signals: row.signals } : {}),
    ...(row.fetched_at === null ? {} : { fetched_at: row.fetched_at }),
  }
}

function toNote(row: typeof ResearchNoteTable.$inferInsert, source: number): Research.Note {
  return {
    id: `N${row.ordinal}`,
    subquestion: row.subquestion,
    claim: row.claim,
    source: `S${source}`,
    quote: row.quote,
    ...(row.page ? { page: row.page } : {}),
    stance: row.stance,
    support: row.support,
    ...(row.verdict ? { verdict: row.verdict } : {}),
    ...(row.measurement ? { measurement: row.measurement } : {}),
    created_at: row.created_at,
  }
}

/** A repository with no working tree: what the sweep, and Erase for other repositories, need of a run's place. */
function rootless(repository: string) {
  return { repository, root: "", sources: [], held: false }
}

/** A page that had text in the brain, which was forgotten since. */
function forgottenOf(row: SourceRow) {
  return row.document_id === null && (row.status === "read" || row.status === "paywalled")
}

/** "S3" or "N3" as its number. */
function ordinalOf(prefix: "S" | "N", ref: string) {
  const match = new RegExp(`^${prefix}(\\d{1,6})$`, "i").exec(ref.trim())
  return match ? Number(match[1]) : undefined
}

function formatOf(format: string | undefined): BrainSchema.Format {
  return BrainSchema.Format.literals.find((value) => value === format) ?? "text"
}

/** What forgetting a page leaves: the hash of its address or of its text, never either one. */
function tombstone(kind: "url" | "text", value: string) {
  return createHash("sha256").update(`research-${kind}\0${value}`).digest("hex").slice(0, 24)
}

function merge(own: ReadonlyMap<string, number>, other: ReadonlyMap<string, number>, weight: number) {
  const out = new Map(own)
  for (const [term, count] of other) out.set(term, (out.get(term) ?? 0) + count * weight)
  return out
}

function chunks<T>(items: readonly T[], size: number) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  )
}

// The Markdown export: the report as it was saved, then a bibliography of the pages it read.
function markdownOf(detail: Detail) {
  const read = detail.sources.filter((source) => source.status === "read" || source.status === "paywalled")
  const date = (at: number | undefined) => (at === undefined ? "" : ` Read ${new Date(at).toISOString().slice(0, 10)}.`)
  // A page's title is its author's words: its backslashes, brackets and angle brackets are escaped, as the report's
  // Sources table escapes them, so a backslash before "<" cannot leave raw HTML live and "[" cannot start a link.
  const escape = (text: string) =>
    text
      .replace(/[\\[\]<]/g, "\\$&")
      .replace(/\s+/g, " ")
      .trim()
  return (
    [
      detail.report?.trim() ?? `# ${escape(detail.run.question)}\n\nThis run has no report yet.`,
      "## Bibliography",
      read.length === 0
        ? "No pages were read."
        : read
            .map(
              (source) =>
                `- ${source.id}. ${escape(source.title) || source.site}. ${source.site}. <${source.url.replace(/[<>\s]/g, encodeURIComponent)}>.${date(source.fetched_at)}${source.forgotten ? " Forgotten since." : ""}`,
            )
            .join("\n"),
    ].join("\n\n") + "\n"
  )
}
