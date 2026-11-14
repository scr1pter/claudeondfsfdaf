import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@vectordevai/effect-drizzle-sqlite"
import { sql } from "drizzle-orm"
import { getTableConfig, SQLiteColumn, type SQLiteTable } from "drizzle-orm/sqlite-core"
import { Effect, Layer } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainDatabase } from "@vectordevai/core/brain/database"
import first from "@vectordevai/core/brain/migration/20261018000000_brain"
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
  BrainPassageTable,
  BrainPendingTable,
  BrainPostingTable,
  BrainRecordTable,
  BrainReviewMemoryScopeStateTable,
  BrainReviewMemorySourceTable,
  BrainReviewMemoryStateTable,
  BrainReviewMemoryTable,
  BrainReviewTable,
  BrainSectionTable,
  BrainSkillListingTable,
  BrainSkillTable,
  BrainSkillUseTable,
  BrainSkillVersionTable,
  BrainSourceTable,
  BrainStateTable,
  BrainTermTable,
  BrainTombstoneTable,
  BrainUseTable,
  BrainVectorTable,
  BrainWorkflowRunTable,
} from "@vectordevai/core/brain/sql"
import { DatabaseMigration } from "@vectordevai/core/database/migration"
import { Global } from "@vectordevai/core/global"
import { tmpdir } from "../fixture/tmpdir"

const TABLES: readonly SQLiteTable[] = [
  BrainEntryTable,
  BrainEvidenceTable,
  BrainEventTable,
  BrainTombstoneTable,
  BrainSourceTable,
  BrainStateTable,
  BrainUseTable,
  BrainSkillTable,
  BrainSkillVersionTable,
  BrainSkillUseTable,
  BrainSkillListingTable,
  BrainWorkflowRunTable,
  BrainDocumentTable,
  BrainSectionTable,
  BrainItemTable,
  BrainPassageTable,
  BrainRecordTable,
  BrainTermTable,
  BrainPostingTable,
  BrainAnchorTable,
  BrainPendingTable,
  BrainEdgeTable,
  BrainVectorTable,
  BrainJobTable,
  BrainReviewTable,
  BrainCodeFileTable,
  BrainCodeSymbolTable,
  BrainCodeLiteralTable,
  BrainReviewMemoryTable,
  BrainReviewMemorySourceTable,
  BrainReviewMemoryStateTable,
  BrainReviewMemoryScopeStateTable,
]

// The knowledge tables, which only documents and the code they are linked to fill.
const KNOWLEDGE: readonly SQLiteTable[] = [
  BrainDocumentTable,
  BrainSectionTable,
  BrainItemTable,
  BrainPassageTable,
  BrainRecordTable,
  BrainTermTable,
  BrainPostingTable,
  BrainAnchorTable,
  BrainPendingTable,
  BrainEdgeTable,
  BrainVectorTable,
  BrainJobTable,
  BrainReviewTable,
  BrainCodeFileTable,
  BrainCodeSymbolTable,
  BrainCodeLiteralTable,
]

const place = (repository: string, root: string): Brain.Place => ({ repository, root, sources: [], held: false })

describe("Brain knowledge migration", () => {
  test("a brain from the first migration upgrades in place and keeps what it held", async () => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "config")
    const data = path.join(tmp.path, "data")
    const file = path.join(data, "brain", "brain.db")
    await fs.mkdir(path.dirname(file), { recursive: true })
    // What an install before documents left: the first migration's tables, an entry in use, its use and the state row.
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* DatabaseMigration.applyOnly(db, [first])
        yield* db.run(sql`
          INSERT INTO brain_entry (id, scope, repository_id, kind, origin, status, body, paths, terms, norm_hash,
            confidence, created_at, updated_at, related)
          VALUES ('m1a2b3', 'repository', 'repo-1', 'lesson', 'user', 'active',
            'Deploy staging from the release branch.', '[]', ${JSON.stringify({ deploy: 1, staging: 1, release: 1, branch: 1 })},
            'hash', 1, 1, 1, '[]')
        `)
        yield* db.run(
          sql`INSERT INTO brain_use (session_id, entry_id, tier, tokens, at) VALUES ('ses_1', 'm1a2b3', 'recall', 12, 1)`,
        )
        yield* db.run(sql`INSERT INTO brain_state (repository_id, revision, learning) VALUES ('repo-1', 7, false)`)
        yield* db.run(
          sql`INSERT INTO brain_event (entry_id, repository_id, at, action, actor) VALUES ('', 'repo-1', 1, 'forgotten', 'user')`,
        )
      }).pipe(Effect.provide(SqliteClient.layer({ filename: file })), Effect.scoped),
    )

    const recalled = await Effect.runPromise(
      Effect.gen(function* () {
        const brain = yield* Brain.Service
        return yield* brain.recall(place("repo-1", tmp.path), {
          query: "how do we deploy staging?",
          budget: 300,
          personal: false,
        })
      }).pipe(
        Effect.provide(
          Brain.layerFor({ file, data, config }).pipe(
            Layer.provide(Layer.succeed(Global.Service, Global.make({ config, data }))),
          ),
        ),
      ),
    )
    expect(recalled.ids).toEqual(["m1a2b3"])

    const db = new Database(file, { readonly: true })
    const migrations = db.query("SELECT id FROM migration ORDER BY id").all()
    const state = db
      .query(
        "SELECT revision, revocation_revision, learning, knowledge_revision, items, item_length_sum, repository_docs, keep_originals, scanned_at FROM brain_state",
      )
      .all()
    const uses = db.query("SELECT entry_id, request_id, cited, outcome FROM brain_use ORDER BY id").all()
    const documents = db.query("SELECT count(*) AS n FROM brain_document").get()
    const entries = db.query("SELECT id, private FROM brain_entry").all()
    db.close()
    expect(migrations).toEqual([
      { id: "20261018000000_brain" },
      { id: "20261101000000_knowledge" },
      { id: "20261102000000_private_memory" },
      { id: "20261103000000_tombstone_terms" },
      { id: "20261104000000_credit" },
      { id: "20261120000000_code" },
      { id: "20261121000000_credited_once" },
      { id: "20261201000000_research" },
      { id: "20261202000000_facets" },
      { id: "20261203000000_revocation" },
      { id: "20261210000000_learned_skills" },
      { id: "20261211000000_workflow" },
      { id: "20261212000000_research_claims" },
      { id: "20261213000000_codium_brain" },
      { id: "20261214000000_codium_workflow" },
      { id: "20261216000000_review_memory" },
      { id: "20261217000000_review_memory_scope" },
      { id: "20261218000000_review_memory_source" },
    ])
    // What was learned before private memory existed is not private.
    expect(entries).toEqual([{ id: "m1a2b3", private: 0 }])
    expect(state).toEqual([
      {
        revision: 7,
        revocation_revision: 1,
        learning: 0,
        knowledge_revision: 0,
        items: 0,
        item_length_sum: 0,
        repository_docs: 1,
        keep_originals: 0,
        scanned_at: null,
      },
    ])
    expect(uses).toEqual([{ entry_id: "m1a2b3", request_id: null, cited: 0, outcome: null }])
    expect(documents).toEqual({ n: 0 })
  })

  test("every brain table is as its declaration says, and postings have no rowid", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "brain.db")
    await Effect.runPromise(Effect.scoped(Layer.build(BrainDatabase.layerFor(file))))
    const db = new Database(file, { readonly: true })
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'brain_%' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name)
    const shapes = TABLES.map((table) => ({
      declared: declared(table),
      stored: stored(db, getTableConfig(table).name),
    }))
    const rowid = (() => {
      try {
        db.query("SELECT rowid FROM brain_posting").all()
        return "has a rowid"
      } catch (error) {
        return String(error)
      }
    })()
    db.close()
    expect(tables).toEqual(TABLES.map((table) => getTableConfig(table).name).toSorted())
    for (const shape of shapes) expect(shape.stored).toEqual(shape.declared)
    expect(rowid).toContain("no such column: rowid")
  })

  test("erasing memory erases documents and everything read from them, one repository at a time", async () => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "config")
    const data = path.join(tmp.path, "data")
    const layer = Brain.layer.pipe(
      Layer.provideMerge(BrainDatabase.layerFor(":memory:")),
      Layer.provide(Layer.succeed(Global.Service, Global.make({ config, data }))),
    )
    const counts = await Effect.runPromise(
      Effect.gen(function* () {
        const brain = yield* Brain.Service
        const database = yield* BrainDatabase.Service
        const count = () =>
          Effect.forEach(KNOWLEDGE, (table) =>
            database.db
              .get<{ n: number }>(sql`SELECT count(*) AS n FROM ${table}`)
              .pipe(Effect.map((row) => [getTableConfig(table).name, row?.n ?? 0] as const)),
          ).pipe(Effect.map((rows) => Object.fromEntries(rows)))
        const knowledge = () =>
          database.db.all<{
            repository_id: string
            knowledge_revision: number
            items: number
            item_length_sum: number
          }>(
            sql`SELECT repository_id, knowledge_revision, items, item_length_sum FROM brain_state WHERE repository_id != '' ORDER BY repository_id`,
          )
        const uses = () => database.db.all<{ entry_id: string }>(sql`SELECT entry_id FROM brain_use ORDER BY entry_id`)
        yield* seed(database.db, "repo-1", 1)
        yield* seed(database.db, "repo-2", 3)
        const seeded = { tables: yield* count(), uses: yield* uses() }
        yield* brain.erase(place("repo-1", tmp.path), "personal")
        const personal = { tables: yield* count(), uses: yield* uses() }
        yield* brain.erase(place("repo-1", tmp.path), "repository")
        const repository = { tables: yield* count(), uses: yield* uses(), state: yield* knowledge() }
        yield* brain.erase(place("repo-1", tmp.path), "all")
        return {
          seeded,
          personal,
          repository,
          all: { tables: yield* count(), uses: yield* uses(), state: yield* knowledge() },
        }
      }).pipe(Effect.provide(layer)),
    )
    // A row per repository in every table, and two items: the passage and the record.
    const each = (repositories: number) => ({
      ...Object.fromEntries(KNOWLEDGE.map((table) => [getTableConfig(table).name, repositories])),
      brain_item: 2 * repositories,
    })
    const refs = (repository: string) => [`p${repository}`, `r${repository}`].map((ref) => ({ entry_id: ref }))
    expect(counts.seeded).toEqual({
      tables: each(2),
      uses: [...refs("repo-1"), ...refs("repo-2")].toSorted((a, b) => a.entry_id.localeCompare(b.entry_id)),
    })
    // Documents are the repository's, so erasing personal memory leaves them.
    expect(counts.personal).toEqual(counts.seeded)
    expect(counts.repository).toEqual({
      tables: each(1),
      uses: refs("repo-2"),
      state: [
        { repository_id: "repo-1", knowledge_revision: 4, items: 0, item_length_sum: 0 },
        { repository_id: "repo-2", knowledge_revision: 3, items: 2, item_length_sum: 9 },
      ],
    })
    expect(counts.all).toEqual({
      tables: each(0),
      uses: [],
      state: [
        { repository_id: "repo-1", knowledge_revision: 5, items: 0, item_length_sum: 0 },
        { repository_id: "repo-2", knowledge_revision: 4, items: 0, item_length_sum: 0 },
      ],
    })
  })
})

// One row in every knowledge table for a repository: a document with a section, a passage and a record (two items),
// a term and its posting, a code link, a pending identifier, an edge, a vector, a job and a review item, and a code
// file with a symbol and a literal; plus the use of both items, and the state a reading leaves.
function seed(db: BrainDatabase.Database, repository: string, item: number) {
  return Effect.gen(function* () {
    const document = `d${repository}`
    const now = Date.now()
    yield* db
      .insert(BrainDocumentTable)
      .values({
        id: document,
        repository_id: repository,
        lineage: "api-spec",
        ordinal: 1,
        name: "api-spec.md",
        title: "API spec",
        format: "markdown",
        origin: "upload",
        visibility: "private",
        content_hash: "hash",
        bytes: 120,
        unread: [],
        status: "searchable",
        stats: {
          tokens: 30,
          read: 1,
          sections: 1,
          passages: 1,
          records: 1,
          kinds: {
            requirement: 1,
            constraint: 0,
            decision: 0,
            contract: 0,
            procedure: 0,
            term: 0,
            entity: 0,
            fact: 0,
            question: 0,
          },
          held: 0,
          linked: 1,
          embedded: 1,
        },
        warnings: [],
        extractor: 1,
        created_at: now,
        updated_at: now,
      })
      .run()
    yield* db
      .insert(BrainSectionTable)
      .values({
        id: `x${repository}`,
        document_id: document,
        ordinal: 0,
        level: 1,
        heading: "Limits",
        path: "Limits",
        kind: "section",
        tokens: 30,
      })
      .run()
    yield* db
      .insert(BrainItemTable)
      .values(
        (["passage", "record"] as const).map((type, index) => ({
          id: item + index,
          repository_id: repository,
          type,
          ref: `${type[0]}${repository}`,
          document_id: document,
          visibility: "private" as const,
          status: "active" as const,
          length: 4 + index,
          confidence: 0.9,
        })),
      )
      .run()
    yield* db
      .insert(BrainPassageTable)
      .values({
        id: `p${repository}`,
        item,
        document_id: document,
        section_id: `x${repository}`,
        ordinal: 0,
        header: "API spec > Limits",
        body: "Clients must retry at most 3 times.",
        tokens: 9,
        span_start: 0,
        span_end: 35,
        norm_hash: "hash",
      })
      .run()
    yield* db
      .insert(BrainRecordTable)
      .values({
        id: `r${repository}`,
        item: item + 1,
        document_id: document,
        passage_id: `p${repository}`,
        section_id: `x${repository}`,
        kind: "requirement",
        key: "requirement|retry",
        subject: "retry",
        card: "Clients must retry at most 3 times.",
        quote: "Clients must retry at most 3 times.",
        quote_hash: "hash",
        fields: { modality: "must" },
        polarity: "",
        rule: "lowercase-must",
        origin: "extracted",
        span_start: 0,
        span_end: 35,
        norm_hash: "hash",
        created_at: now,
        updated_at: now,
      })
      .run()
    yield* db.insert(BrainTermTable).values({ id: item, repository_id: repository, term: "retry", df: 1 }).run()
    yield* db.insert(BrainPostingTable).values({ term: item, item, count: 1 }).run()
    yield* db
      .insert(BrainAnchorTable)
      .values({
        repository_id: repository,
        owner: `r${repository}`,
        path: "src/retry.ts",
        method: "definition",
        weight: 1,
        file_hash: "hash",
        status: "fresh",
        origin: "extracted",
        checked_at: now,
        created_at: now,
      })
      .run()
    yield* db
      .insert(BrainPendingTable)
      .values({
        repository_id: repository,
        owner: `r${repository}`,
        identifier: "retryBudget",
        kind: "symbol",
        created_at: now,
      })
      .run()
    yield* db
      .insert(BrainEdgeTable)
      .values({
        repository_id: repository,
        source: `m${repository}`,
        target: `r${repository}`,
        type: "derived_from",
        weight: 0.9,
        created_at: now,
      })
      .run()
    yield* db
      .insert(BrainVectorTable)
      .values({
        item,
        repository_id: repository,
        model: "arctic-embed-xs-q8",
        q8: Buffer.alloc(384),
        bits: Buffer.alloc(48),
        scale: 0.01,
        norm_hash: "hash",
        embedded_at: now,
      })
      .run()
    yield* db
      .insert(BrainJobTable)
      .values({
        id: `j${repository}`,
        repository_id: repository,
        document_id: document,
        kind: "embed",
        state: "queued",
        next_at: now,
        created_at: now,
        updated_at: now,
      })
      .run()
    yield* db
      .insert(BrainReviewTable)
      .values({
        id: `v${repository}`,
        repository_id: repository,
        kind: "drift",
        a: `r${repository}`,
        subject: "retry",
        detail: { document: "3", code: "5" },
        status: "open",
        created_at: now,
        updated_at: now,
      })
      .run()
    yield* db
      .insert(BrainCodeFileTable)
      .values({
        repository_id: repository,
        path: "src/retry.ts",
        content_hash: "hash",
        bytes: 40,
        mtime: now,
        language: "typescript",
        imports: [],
        dependencies: [],
        co_change: {},
        synced_at: now,
      })
      .run()
    yield* db
      .insert(BrainCodeSymbolTable)
      .values({
        repository_id: repository,
        path: "src/retry.ts",
        name: "retryBudget",
        kind: "constant",
        line: 1,
        exported: true,
        signature_hash: "hash",
      })
      .run()
    yield* db
      .insert(BrainCodeLiteralTable)
      .values({ repository_id: repository, path: "src/retry.ts", kind: "env", value: "RETRY_LIMIT", line: 1 })
      .run()
    yield* db
      .insert(BrainUseTable)
      .values(
        ["p", "r"].map((prefix) => ({
          session_id: "ses_1",
          entry_id: `${prefix}${repository}`,
          tier: "recall" as const,
          tokens: 10,
          at: now,
        })),
      )
      .run()
    yield* db
      .insert(BrainStateTable)
      .values({ repository_id: repository, knowledge_revision: 3, items: 2, item_length_sum: 9 })
      .run()
  }).pipe(Effect.orDie)
}

// A table as its drizzle declaration describes it, in the terms SQLite reports it in.
function declared(table: SQLiteTable) {
  const config = getTableConfig(table)
  const names = (columns: readonly unknown[]) =>
    columns.filter((column): column is SQLiteColumn => column instanceof SQLiteColumn).map((column) => column.name)
  return {
    name: config.name,
    columns: config.columns
      // An autoincrement key counts as having a default to drizzle; SQLite reports none for any primary key.
      .map((column) => ({
        name: column.name,
        type: column.getSQLType(),
        notNull: column.notNull,
        default: column.hasDefault && !column.primary,
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name)),
    primary: [
      ...config.columns.filter((column) => column.primary).map((column) => column.name),
      ...config.primaryKeys.flatMap((key) => names(key.columns)),
    ],
    indexes: [
      ...config.indexes.map((index) => ({ unique: index.config.unique, columns: names(index.config.columns) })),
      ...config.columns.filter((column) => column.isUnique).map((column) => ({ unique: true, columns: [column.name] })),
    ].toSorted(byColumns),
    named: config.indexes.map((index) => index.config.name).toSorted(),
    foreign: config.foreignKeys
      .map((key) => {
        const reference = key.reference()
        return {
          from: names(reference.columns),
          table: getTableConfig(reference.foreignTable).name,
          to: names(reference.foreignColumns),
          delete: key.onDelete ?? "no action",
        }
      })
      .toSorted((a, b) => a.from.join().localeCompare(b.from.join())),
  }
}

// Indexes by their columns, then plain before unique: a learned skill's key has both, the plain lookup and the
// partial unique index that allows one live entry per key.
function byColumns(a: { unique: boolean; columns: string[] }, b: { unique: boolean; columns: string[] }) {
  return a.columns.join().localeCompare(b.columns.join()) || Number(a.unique) - Number(b.unique)
}

// The same, read back from the database the migrations built.
function stored(db: Database, name: string) {
  type Column = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }
  type Index = { name: string; unique: number; origin: string }
  type Key = { id: number; table: string; from: string; to: string; on_delete: string }
  const columns = db.query(`PRAGMA table_info('${name}')`).all() as Column[]
  const primary = columns.filter((column) => column.pk > 0).toSorted((a, b) => a.pk - b.pk)
  // A lone primary key column is NOT NULL to drizzle, and SQLite enforces it whether or not the SQL says so.
  const single = primary.length === 1 ? primary[0]?.name : undefined
  const indexes = (db.query(`PRAGMA index_list('${name}')`).all() as Index[]).filter((index) => index.origin !== "pk")
  const keys = db.query(`PRAGMA foreign_key_list('${name}')`).all() as Key[]
  return {
    name,
    columns: columns
      .map((column) => ({
        name: column.name,
        type: column.type.toLowerCase(),
        notNull: column.notnull === 1 || column.name === single,
        default: column.dflt_value !== null,
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name)),
    primary: primary.map((column) => column.name),
    indexes: indexes
      .map((index) => ({
        unique: index.unique === 1,
        columns: (db.query(`PRAGMA index_info('${index.name}')`).all() as { name: string }[]).map(
          (column) => column.name,
        ),
      }))
      .toSorted(byColumns),
    named: indexes
      .filter((index) => index.origin === "c" && !index.name.endsWith("_unique"))
      .map((index) => index.name)
      .toSorted(),
    foreign: [...new Set(keys.map((key) => key.id))]
      .map((id) => {
        const parts = keys.filter((key) => key.id === id)
        return {
          from: parts.map((key) => key.from),
          table: parts[0]?.table,
          to: parts.map((key) => key.to),
          delete: parts[0]?.on_delete.toLowerCase(),
        }
      })
      .toSorted((a, b) => a.from.join().localeCompare(b.from.join())),
  }
}
