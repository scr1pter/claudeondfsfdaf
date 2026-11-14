import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import path from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@vectordevai/effect-drizzle-sqlite"
import { sql } from "drizzle-orm"
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core"
import { Effect, Layer } from "effect"
import { BrainDatabase } from "@vectordevai/core/brain/database"
import first from "@vectordevai/core/brain/migration/20261018000000_brain"
import knowledge from "@vectordevai/core/brain/migration/20261101000000_knowledge"
import privateMemory from "@vectordevai/core/brain/migration/20261102000000_private_memory"
import tombstoneTerms from "@vectordevai/core/brain/migration/20261103000000_tombstone_terms"
import credit from "@vectordevai/core/brain/migration/20261104000000_credit"
import code from "@vectordevai/core/brain/migration/20261120000000_code"
import creditedOnce from "@vectordevai/core/brain/migration/20261121000000_credited_once"
import research from "@vectordevai/core/brain/migration/20261201000000_research"
import facets from "@vectordevai/core/brain/migration/20261202000000_facets"
import revocation from "@vectordevai/core/brain/migration/20261203000000_revocation"
import learnedSkills from "@vectordevai/core/brain/migration/20261210000000_learned_skills"
import workflow from "@vectordevai/core/brain/migration/20261211000000_workflow"
import researchClaims from "@vectordevai/core/brain/migration/20261212000000_research_claims"
import reviewMemory from "@vectordevai/core/brain/migration/20261216000000_review_memory"
import reviewMemoryScope from "@vectordevai/core/brain/migration/20261217000000_review_memory_scope"
import {
  BrainSkillListingTable,
  BrainSkillTable,
  BrainSkillUseTable,
  BrainSkillVersionTable,
  BrainStateTable,
  BrainWorkflowRunTable,
} from "@vectordevai/core/brain/sql"
import { DatabaseMigration } from "@vectordevai/core/database/migration"
import { tmpdir } from "../fixture/tmpdir"

// The learned-skills and workflow migrations (section 4.2, 4.3): new tables beside brain_entry and four new columns on
// the state row, applied to a fresh brain.db and to one an earlier build left.

const NEW: readonly SQLiteTable[] = [
  BrainSkillTable,
  BrainSkillVersionTable,
  BrainSkillUseTable,
  BrainSkillListingTable,
  BrainWorkflowRunTable,
]

const build = (file: string) => Effect.runPromise(Effect.scoped(Layer.build(BrainDatabase.layerFor(file))))

// A table as its drizzle declaration has it and as SQLite stored it: columns, nullability, defaults and indexes.
function shapes(db: Database, table: SQLiteTable) {
  const config = getTableConfig(table)
  const columns = db.query(`PRAGMA table_info('${config.name}')`).all() as {
    name: string
    type: string
    notnull: number
    dflt_value: string | null
    pk: number
  }[]
  const single = columns.filter((column) => column.pk > 0).length === 1
  const indexes = (
    db.query(`PRAGMA index_list('${config.name}')`).all() as { name: string; unique: number; origin: string }[]
  )
    .filter((index) => index.origin === "c")
    .map((index) => `${index.name}:${index.unique}`)
    .toSorted()
  return {
    declared: {
      columns: config.columns
        .map(
          (column) => `${column.name}:${column.getSQLType()}:${column.notNull}:${column.hasDefault && !column.primary}`,
        )
        .toSorted(),
      indexes: config.indexes.map((index) => `${index.config.name}:${index.config.unique ? 1 : 0}`).toSorted(),
    },
    stored: {
      columns: columns
        .map(
          (column) =>
            `${column.name}:${column.type.toLowerCase()}:${column.notnull === 1 || (single && column.pk > 0)}:${column.dflt_value !== null}`,
        )
        .toSorted(),
      indexes,
    },
  }
}

describe("Brain learned-skills migrations", () => {
  test("a fresh brain.db gets every new table as declared, and the state row's four settings", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "brain.db")
    await build(file)
    const db = new Database(file, { readonly: true })
    const tables = [...NEW, BrainStateTable].map((table) => shapes(db, table))
    const state = (db.query("PRAGMA table_info('brain_state')").all() as { name: string }[]).map(
      (column) => column.name,
    )
    db.close()
    for (const table of tables) expect(table.stored).toEqual(table.declared)
    expect(state).toEqual(
      expect.arrayContaining(["skill_learning", "skill_drafter", "workflow_learning", "workflow_explore"]),
    )
  })

  test("a brain.db an earlier build left at the facets migration upgrades and keeps what it held", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "brain.db")
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* DatabaseMigration.applyOnly(db, [
          first,
          knowledge,
          privateMemory,
          tombstoneTerms,
          credit,
          code,
          creditedOnce,
          research,
          facets,
        ])
        yield* db.run(sql`
          INSERT INTO brain_entry (id, scope, repository_id, kind, origin, status, body, paths, terms, norm_hash,
            confidence, created_at, updated_at, related)
          VALUES ('m1a2b3', 'repository', 'repo-1', 'lesson', 'agent', 'active', 'Run the brain tests from packages/core.',
            '[]', '{}', 'hash', 0.8, 1, 1, '[]')
        `)
        yield* db.run(sql`INSERT INTO brain_state (repository_id, learning, model_learner) VALUES ('', false, 'off')`)
      }).pipe(Effect.provide(SqliteClient.layer({ filename: file })), Effect.scoped),
    )
    await build(file)
    const db = new Database(file, { readonly: true })
    const migrations = (db.query("SELECT id FROM migration ORDER BY id").all() as { id: string }[]).map((row) => row.id)
    const entries = db.query("SELECT id, kind, status FROM brain_entry").all()
    const state = db
      .query(
        "SELECT learning, model_learner, skill_learning, skill_drafter, workflow_learning, workflow_explore FROM brain_state",
      )
      .all()
    db.close()
    // The whole tail from the last migration that earlier build had, so a later migration cannot silently shift it.
    expect(migrations.slice(migrations.indexOf("20261202000000_facets"))).toEqual([
      "20261202000000_facets",
      "20261203000000_revocation",
      "20261210000000_learned_skills",
      "20261211000000_workflow",
      "20261212000000_research_claims",
      "20261216000000_review_memory",
      "20261217000000_review_memory_scope",
      "20261218000000_review_memory_source",
    ])
    expect(entries).toEqual([{ id: "m1a2b3", kind: "lesson", status: "active" }])
    // Unset settings read as the defaults: review, local-only, apply, no exploring.
    expect(state).toEqual([
      {
        learning: 0,
        model_learner: "off",
        skill_learning: null,
        skill_drafter: null,
        workflow_learning: null,
        workflow_explore: null,
      },
    ])
  })

  test("a brain.db an earlier VectorScope build migrated under the old review memory ids opens and keeps its rows", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "brain.db")
    // That build ran the first two review memory migrations under their ids before Codium's Brain migrations took
    // 20261213 and 20261214, and never had the source table.
    const earlier = (migration: DatabaseMigration.Migration, id: string) => ({ id, up: migration.up })
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* DatabaseMigration.applyOnly(db, [
          first,
          knowledge,
          privateMemory,
          tombstoneTerms,
          credit,
          code,
          creditedOnce,
          research,
          facets,
          revocation,
          learnedSkills,
          workflow,
          researchClaims,
          earlier(reviewMemory, "20261213000000_review_memory"),
          earlier(reviewMemoryScope, "20261214000000_review_memory_scope"),
        ])
        yield* db.run(sql`
          INSERT INTO brain_review_memory (id, repository_id, scope_id, kind, status, visibility, body, paths, citations,
            reason, origin, created_at, updated_at)
          VALUES ('r1', 'repo-1', 'scope-1', 'preference', 'active', 'repository', 'Prefer an explicit return.', '[]',
            '[]', 'An explicit owner preference.', 'owner', 1, 1)
        `)
        yield* db.run(sql`
          INSERT INTO brain_review_memory_scope_state (repository_id, scope_id, enabled, generation)
          VALUES ('repo-1', 'scope-1', 1, 3)
        `)
      }).pipe(Effect.provide(SqliteClient.layer({ filename: file })), Effect.scoped),
    )
    // Re-running either earlier migration would fail on its existing table or column, so opening proves they were skipped.
    await build(file)
    await build(file)
    const db = new Database(file, { readonly: true })
    const migrations = (db.query("SELECT id FROM migration ORDER BY id").all() as { id: string }[]).map((row) => row.id)
    const memory = db.query("SELECT id, scope_id, body FROM brain_review_memory").all()
    const scope = db
      .query("SELECT repository_id, scope_id, enabled, generation FROM brain_review_memory_scope_state")
      .all()
    const sources = db.query("SELECT count(*) AS n FROM brain_review_memory_source").get()
    db.close()
    expect(migrations.slice(migrations.indexOf("20261212000000_research_claims"))).toEqual([
      "20261212000000_research_claims",
      "20261213000000_review_memory",
      "20261214000000_review_memory_scope",
      "20261216000000_review_memory",
      "20261217000000_review_memory_scope",
      "20261218000000_review_memory_source",
    ])
    expect(memory).toEqual([{ id: "r1", scope_id: "scope-1", body: "Prefer an explicit return." }])
    expect(scope).toEqual([{ repository_id: "repo-1", scope_id: "scope-1", enabled: 1, generation: 3 }])
    expect(sources).toEqual({ n: 0 })
  })

  test("deleting a skill's entry deletes its skill row, and a key has one live entry at most", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "brain.db")
    await build(file)
    const db = new Database(file)
    db.run("PRAGMA foreign_keys = ON")
    const entry = (id: string) =>
      db.run(
        `INSERT INTO brain_entry (id, scope, repository_id, kind, origin, status, body, paths, terms, norm_hash, confidence, created_at, updated_at, related)
         VALUES ('${id}', 'repository', 'skill:repo-1', 'skill', 'agent', 'active', 'card', '[]', '{}', '${id}', 0.8, 1, 1, '[]')`,
      )
    const skill = (id: string, live: number) =>
      db.run(
        `INSERT INTO brain_skill (entry_id, repository_id, skill_key, name, description, procedure, checks, commands, version, drafter, live)
         VALUES ('${id}', 'repo-1', 'bun-test-root', 'learned-bun-test-root', 'd', 'p', '[]', '[]', 1, 'rules', ${live})`,
      )
    entry("s000001")
    entry("s000002")
    entry("s000003")
    skill("s000001", 1)
    skill("s000002", 0)
    const second = (() => {
      try {
        skill("s000003", 1)
        return "inserted"
      } catch (error) {
        return String(error)
      }
    })()
    db.run("DELETE FROM brain_entry WHERE id = 's000001'")
    const left = db.query("SELECT entry_id FROM brain_skill ORDER BY entry_id").all()
    // With the live one gone, another may be live.
    skill("s000003", 1)
    db.close()
    expect(second).toContain("UNIQUE constraint failed")
    expect(left).toEqual([{ entry_id: "s000002" }])
  })
})
