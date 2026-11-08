export * as SkillStore from "./skill-store"

import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { and, desc, eq, inArray, isNotNull, like, lt, notInArray, sql } from "drizzle-orm"
import { Effect } from "effect"
import { BrainCredit } from "./credit"
import type { BrainDatabase } from "./database"
import {
  BrainEntryTable,
  BrainEventTable,
  BrainEvidenceTable,
  BrainSkillListingTable,
  BrainSkillTable,
  BrainSkillUseTable,
  BrainSkillVersionTable,
  BrainTombstoneTable,
  BrainWorkflowRunTable,
} from "./sql"

// The SQL learned skills and workflow insights share with the brain: Brain calls it inside its own erase and tidying
// transactions and BrainSkill and BrainWorkflow call it for their writes, so neither service needs the other.
//
// Skill entries live under the repository id "skill:<repository>", which no memory query of this or an older build
// reads. An older build's erase cannot see them either, so the first skill or workflow row written for a repository
// comes with a marker tombstone in the repository's own scope. An older build's erase of the repository or of
// everything deletes the repository's tombstones, the marker with them, and `reconcile` then finishes that erase.

type Database = BrainDatabase.Database
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
export type Handle = Database | Transaction

/** The marker's hash, which no entry's normalised text can have. */
export const MARKER = "vector:learning-marker"

/** The marker never expires, so tidying (this build's or an older one's) keeps it. */
export const FOREVER = 253402300799000

const DAY = 24 * 60 * 60 * 1000

export const KEEP = {
  /** A superseded entry's versions, a use and a listing are kept this long. */
  days: 180,
  /** A draft nobody reviewed is dropped after this long. */
  pendingDays: 60,
  /** Versions kept per key. */
  versions: 20,
  /** Active skills per repository; tidying archives the least proven past it. */
  skills: 50,
  /** Put-away skills per repository; tidying deletes the oldest past it, with their versions. */
  archived: 100,
} as const

/** The repository id a repository's skill entries, their events and their tombstones live under. */
export function namespace(repository: string) {
  return `skill:${repository}`
}

/** A forgotten or rejected key's tombstone hash, in the namespace. */
export function tombstone(key: string) {
  return `skill:${createHash("sha256").update(key).digest("hex")}`
}

/**
 * Deletes every skill and workflow row of these repositories, or of all of them: entries, versions, uses, listings,
 * workflow runs, and the namespace's events and tombstones. Returns the skill entries deleted.
 */
export const eraseScope = Effect.fnUntraced(function* (tx: Handle, repositories: readonly string[] | undefined) {
  const spaces = repositories?.map(namespace)
  const entries = yield* tx
    .delete(BrainEntryTable)
    .where(spaces ? inArray(BrainEntryTable.repository_id, spaces) : like(BrainEntryTable.repository_id, "skill:%"))
    .returning({ id: BrainEntryTable.id })
    .all()
  yield* Effect.forEach(
    [BrainSkillTable, BrainSkillVersionTable, BrainSkillUseTable, BrainSkillListingTable, BrainWorkflowRunTable],
    (table) =>
      tx
        .delete(table)
        .where(repositories ? inArray(table.repository_id, [...repositories]) : undefined)
        .run(),
    { discard: true },
  )
  yield* Effect.forEach(
    [BrainEventTable, BrainTombstoneTable],
    (table) =>
      tx
        .delete(table)
        .where(spaces ? inArray(table.repository_id, spaces) : like(table.repository_id, "skill:%"))
        .run(),
    { discard: true },
  )
  return entries.length
})

/**
 * What one session taught, taken back: its run evidence, uses, listing, workflow runs and the skill text it wrote. A
 * live skill whose current text came from that session goes back to the newest of its own texts left, as a rollback,
 * never to another entry's draft of the same key; one Vector put in use that no longer has two sessions' evidence goes
 * back to the owner's review; an entry with no text left, or with no evidence left that the owner did not write, is
 * deleted and its key tombstoned once no entry of it remains. Returns the entries deleted and the skills changed.
 */
export const eraseSession = Effect.fnUntraced(function* (tx: Handle, repository: string, sessionID: string) {
  const space = namespace(repository)
  const unvouched = yield* tx
    .delete(BrainEvidenceTable)
    .where(
      and(
        eq(BrainEvidenceTable.type, "run"),
        eq(BrainEvidenceTable.session_id, sessionID),
        inArray(
          BrainEvidenceTable.entry_id,
          tx.select({ id: BrainEntryTable.id }).from(BrainEntryTable).where(eq(BrainEntryTable.repository_id, space)),
        ),
      ),
    )
    .returning({ entry: BrainEvidenceTable.entry_id })
    .all()
  yield* Effect.forEach(
    [BrainSkillUseTable, BrainSkillListingTable, BrainWorkflowRunTable],
    (table) =>
      tx
        .delete(table)
        .where(and(eq(table.repository_id, repository), eq(table.session_id, sessionID)))
        .run(),
    { discard: true },
  )
  const taken = yield* tx
    .delete(BrainSkillVersionTable)
    .where(and(eq(BrainSkillVersionTable.repository_id, repository), eq(BrainSkillVersionTable.session_id, sessionID)))
    .returning({ entry: BrainSkillVersionTable.entry_id, version: BrainSkillVersionTable.version })
    .all()
  const skills = yield* tx.select().from(BrainSkillTable).where(eq(BrainSkillTable.repository_id, repository)).all()
  const lost = new Set(taken.map((row) => `${row.entry}\0${row.version}`))
  const now = Date.now()
  for (const skill of skills.filter((item) => item.live && lost.has(`${item.entry_id}\0${item.version}`))) {
    const newest = yield* tx
      .select()
      .from(BrainSkillVersionTable)
      .where(
        and(
          eq(BrainSkillVersionTable.repository_id, repository),
          eq(BrainSkillVersionTable.skill_key, skill.skill_key),
          // Versions are numbered per key, so a newer draft of the key (one waiting for review, or held) is another
          // entry's: its text never goes live without the owner.
          eq(BrainSkillVersionTable.entry_id, skill.entry_id),
        ),
      )
      .orderBy(desc(BrainSkillVersionTable.version))
      .get()
    if (!newest) continue
    yield* restore(tx, skill, newest, { actor: "vector", at: now })
  }
  // Only what this session's erase took something from: an entry it never taught is no business of it.
  const touched = new Set([...taken, ...unvouched].map((row) => row.entry))
  const returned = yield* returnUnvouched(tx, repository, now, [...touched])
  const versioned = new Set(
    (yield* tx
      .selectDistinct({ entry: BrainSkillVersionTable.entry_id })
      .from(BrainSkillVersionTable)
      .where(eq(BrainSkillVersionTable.repository_id, repository))
      .all()).map((row) => row.entry),
  )
  const evidenced = new Set(
    (yield* tx
      .selectDistinct({ entry: BrainEvidenceTable.entry_id })
      .from(BrainEvidenceTable)
      .innerJoin(BrainEntryTable, eq(BrainEntryTable.id, BrainEvidenceTable.entry_id))
      .where(eq(BrainEntryTable.repository_id, space))
      .all()).map((row) => row.entry),
  )
  const doomed = skills.filter(
    (skill) =>
      touched.has(skill.entry_id) &&
      (!versioned.has(skill.entry_id) || (!evidenced.has(skill.entry_id) && skill.drafter !== "user")),
  )
  yield* remove(
    tx,
    repository,
    doomed.map((skill) => skill.entry_id),
  )
  const left = new Set(skills.filter((skill) => !doomed.includes(skill)).map((skill) => skill.skill_key))
  yield* Effect.forEach(
    [...new Set(doomed.map((skill) => skill.skill_key))].filter((key) => !left.has(key)),
    (key) => bury(tx, repository, key, now),
    { discard: true },
  )
  const restored = skills.filter((item) => item.live && lost.has(`${item.entry_id}\0${item.version}`))
  return {
    removed: doomed.length,
    changed: new Set([...doomed, ...restored].map((item) => item.entry_id).concat(returned)).size,
  }
})

/**
 * A skill Vector put in use on its own stands on run evidence from two sessions that saw its check go green. One with
 * fewer left (a revert or an erase took the rest) is no longer live and goes back to the owner's review, with the text
 * it has now. Checks the given entries, or every live one of the repository. Returns the entries returned.
 */
export const returnUnvouched = Effect.fnUntraced(function* (
  tx: Handle,
  repository: string,
  now: number,
  entries?: readonly string[],
) {
  if (entries?.length === 0) return []
  const promoted = yield* tx
    .select({ id: BrainSkillTable.entry_id })
    .from(BrainSkillTable)
    .where(
      and(
        eq(BrainSkillTable.repository_id, repository),
        eq(BrainSkillTable.live, true),
        eq(BrainSkillTable.approved_by, "vector"),
        entries ? inArray(BrainSkillTable.entry_id, [...entries]) : undefined,
      ),
    )
    .all()
  const vouched = yield* Effect.forEach(promoted, (row) =>
    tx
      .selectDistinct({ session: BrainEvidenceTable.session_id })
      .from(BrainEvidenceTable)
      .where(
        and(
          eq(BrainEvidenceTable.entry_id, row.id),
          eq(BrainEvidenceTable.type, "run"),
          isNotNull(BrainEvidenceTable.command),
          isNotNull(BrainEvidenceTable.session_id),
        ),
      )
      .all()
      .pipe(Effect.map((sessions) => ({ id: row.id, sessions: sessions.length }))),
  )
  const returned = vouched.filter((row) => row.sessions < 2).map((row) => row.id)
  if (returned.length === 0) return []
  yield* tx
    .update(BrainSkillTable)
    .set({ live: false, approved_by: null, approved_at: null })
    .where(inArray(BrainSkillTable.entry_id, returned))
    .run()
  yield* tx
    .update(BrainEntryTable)
    .set({ status: "proposed", updated_at: now })
    .where(inArray(BrainEntryTable.id, returned))
    .run()
  yield* tx
    .insert(BrainEventTable)
    .values(
      returned.map((id) => ({
        entry_id: id,
        repository_id: namespace(repository),
        at: now,
        action: "returned",
        actor: "vector" as const,
        detail: { skillPending: "review" },
      })),
    )
    .run()
  return returned
})

/**
 * Forgets a key: every entry of it, superseded and archived ones too, with their versions, uses and listing rows, and a
 * tombstone so Vector does not draft it again for 180 days. Returns the entries deleted.
 */
export const forgetKey = Effect.fnUntraced(function* (tx: Handle, repository: string, key: string) {
  const entries = (yield* tx
    .select({ id: BrainSkillTable.entry_id })
    .from(BrainSkillTable)
    .where(and(eq(BrainSkillTable.repository_id, repository), eq(BrainSkillTable.skill_key, key)))
    .all()).map((row) => row.id)
  yield* remove(tx, repository, entries)
  yield* tx
    .delete(BrainSkillVersionTable)
    .where(and(eq(BrainSkillVersionTable.repository_id, repository), eq(BrainSkillVersionTable.skill_key, key)))
    .run()
  yield* bury(tx, repository, key, Date.now())
  return entries.length
})

/** Versions whose entry is gone, and the oldest past the cap of a key, keeping every entry's current version. */
export const dropOrphanVersions = Effect.fnUntraced(function* (tx: Handle, repository: string) {
  const orphaned = yield* tx
    .delete(BrainSkillVersionTable)
    .where(
      and(
        eq(BrainSkillVersionTable.repository_id, repository),
        notInArray(
          BrainSkillVersionTable.entry_id,
          tx
            .select({ id: BrainSkillTable.entry_id })
            .from(BrainSkillTable)
            .where(eq(BrainSkillTable.repository_id, repository)),
        ),
      ),
    )
    .returning({ id: BrainSkillVersionTable.id })
    .all()
  const current = new Set(
    (yield* tx
      .select({ entry: BrainSkillTable.entry_id, version: BrainSkillTable.version })
      .from(BrainSkillTable)
      .where(eq(BrainSkillTable.repository_id, repository))
      .all()).map((row) => `${row.entry}\0${row.version}`),
  )
  const versions = yield* tx
    .select({
      id: BrainSkillVersionTable.id,
      key: BrainSkillVersionTable.skill_key,
      entry: BrainSkillVersionTable.entry_id,
      version: BrainSkillVersionTable.version,
    })
    .from(BrainSkillVersionTable)
    .where(eq(BrainSkillVersionTable.repository_id, repository))
    .orderBy(desc(BrainSkillVersionTable.version))
    .all()
  const excess = [...Map.groupBy(versions, (row) => row.key).values()]
    .flatMap((rows) => rows.slice(KEEP.versions))
    .filter((row) => !current.has(`${row.entry}\0${row.version}`))
    .map((row) => row.id)
  if (excess.length) yield* tx.delete(BrainSkillVersionTable).where(inArray(BrainSkillVersionTable.id, excess)).run()
  return orphaned.length + excess.length
})

/**
 * A tidying pass over one repository's skills, run from Brain.consolidate after credit has decayed: skills more often
 * harmful than helpful (twice at least) or unused for 90 days are archived, drafts nobody reviewed in 60 days are
 * dropped, a skill whose files are mostly gone is stale until they are back, the 50 most proven stay active, the 100
 * newest put away stay, and old versions, uses, listings and replaced entries go. Then every repository's rows are
 * reconciled with its marker.
 */
export const tidy = Effect.fnUntraced(function* (
  db: Database,
  place: { readonly repository: string; readonly root: string },
  now: number,
) {
  const space = namespace(place.repository)
  const rows = yield* db
    .select({ entry: BrainEntryTable, skill: BrainSkillTable })
    .from(BrainEntryTable)
    .innerJoin(BrainSkillTable, eq(BrainSkillTable.entry_id, BrainEntryTable.id))
    .where(eq(BrainEntryTable.repository_id, space))
    .all()
    .pipe(Effect.orDie)
  const active = rows.filter((row) => row.entry.status === "active")
  // Credit decays to fractions, so one failure (harmful 1) never archives a skill on its own.
  const harmful = active.filter((row) => row.entry.harmful >= 2 && row.entry.harmful > row.entry.helpful)
  const unused = active.filter((row) => now - inUse(row) > 90 * DAY && row.skill.loads < 2)
  const retired = new Set([...harmful, ...unused].map((row) => row.entry.id))
  const kept = active.filter((row) => !retired.has(row.entry.id))
  const excess = kept
    .toSorted((a, b) => lift(a) - lift(b) || a.skill.loads - b.skill.loads || inUse(a) - inUse(b))
    .slice(0, Math.max(0, kept.length - KEEP.skills))
  const archived = [...retired, ...excess.map((row) => row.entry.id)]
  const pending = rows
    .filter(
      (row) =>
        (row.entry.status === "proposed" || row.entry.status === "quarantined") &&
        now - row.entry.created_at > KEEP.pendingDays * DAY,
    )
    .map((row) => row.entry.id)
  const replaced = rows
    .filter((row) => row.entry.status === "superseded" && row.entry.updated_at < now - KEEP.days * DAY)
    .map((row) => row.entry.id)
  const excessArchived = rows
    .filter(
      (row) =>
        (row.entry.status === "archived" || row.entry.status === "superseded") && !replaced.includes(row.entry.id),
    )
    .toSorted((a, b) => b.entry.updated_at - a.entry.updated_at)
    .slice(KEEP.archived)
    .map((row) => row.entry.id)
  const missing = yield* Effect.forEach(
    kept.filter((row) => !excess.includes(row) && row.entry.paths.length > 0),
    (row) =>
      Effect.promise(() =>
        Promise.all(
          row.entry.paths.map((file) =>
            fs.stat(path.resolve(place.root, file)).then(
              () => false,
              () => true,
            ),
          ),
        ),
      ).pipe(Effect.map((gone) => ({ row, stale: gone.filter(Boolean).length * 2 > gone.length }))),
  )
  const flipped = missing.filter((item) => item.stale !== item.row.entry.stale)
  yield* db
    .transaction((tx) =>
      Effect.gen(function* () {
        if (archived.length) {
          yield* tx
            .update(BrainEntryTable)
            .set({ status: "archived", updated_at: now })
            .where(inArray(BrainEntryTable.id, archived))
            .run()
          yield* tx
            .update(BrainSkillTable)
            .set({ live: false })
            .where(inArray(BrainSkillTable.entry_id, archived))
            .run()
          yield* tx
            .insert(BrainEventTable)
            .values(
              archived.map((id) => ({
                entry_id: id,
                repository_id: space,
                at: now,
                action: "archived",
                actor: "vector" as const,
              })),
            )
            .run()
        }
        yield* remove(tx, place.repository, [...pending, ...replaced, ...excessArchived])
        for (const item of flipped)
          yield* tx
            .update(BrainEntryTable)
            .set({ stale: item.stale })
            .where(eq(BrainEntryTable.id, item.row.entry.id))
            .run()
        yield* tx
          .delete(BrainSkillUseTable)
          .where(
            and(
              eq(BrainSkillUseTable.repository_id, place.repository),
              lt(BrainSkillUseTable.at, now - KEEP.days * DAY),
            ),
          )
          .run()
        // A resumed session whose listing went chooses again.
        yield* tx
          .delete(BrainSkillListingTable)
          .where(
            and(
              eq(BrainSkillListingTable.repository_id, place.repository),
              lt(BrainSkillListingTable.created_at, now - KEEP.days * DAY),
            ),
          )
          .run()
        // History goes after 180 days, as memory's does (Brain.consolidate prunes only its own scopes).
        yield* tx
          .delete(BrainEventTable)
          .where(and(eq(BrainEventTable.repository_id, space), lt(BrainEventTable.at, now - KEEP.days * DAY)))
          .run()
        yield* dropOrphanVersions(tx, place.repository)
      }),
    )
    .pipe(Effect.orDie)
  yield* reconcile(db, "all")
  return { archived: archived.length, dropped: pending.length, stale: flipped.filter((item) => item.stale).length }
})

/**
 * Before the first skill or workflow row of a repository is written: rows left from before an older build's erase are
 * deleted, then the marker goes in, in the same transaction as the write that follows.
 */
export const mark = Effect.fnUntraced(function* (tx: Handle, repository: string) {
  const found = yield* tx
    .select({ until: BrainTombstoneTable.until })
    .from(BrainTombstoneTable)
    .where(and(eq(BrainTombstoneTable.repository_id, repository), eq(BrainTombstoneTable.norm_hash, MARKER)))
    .get()
  if (found) return
  yield* eraseScope(tx, [repository])
  yield* tx
    .insert(BrainTombstoneTable)
    .values({ repository_id: repository, norm_hash: MARKER, until: FOREVER, terms: null, polarity: null })
    .onConflictDoNothing()
    .run()
})

/**
 * Finishes an older build's erase: every repository with skill, version, use, listing or workflow rows but no marker
 * loses them. Run when BrainSkill or BrainWorkflow is first used in a process and in every tidying pass. Logs counts.
 */
export const reconcile = (db: Database, repository: string | "all") => reconciled(db, repository).pipe(Effect.orDie)

const reconciled = Effect.fnUntraced(function* (db: Database, repository: string | "all") {
  const repositories =
    repository !== "all"
      ? [repository]
      : [
          ...new Set(
            [
              ...(yield* Effect.forEach(
                [
                  BrainSkillTable,
                  BrainSkillVersionTable,
                  BrainSkillUseTable,
                  BrainSkillListingTable,
                  BrainWorkflowRunTable,
                ],
                (table) => db.selectDistinct({ id: table.repository_id }).from(table).all(),
              )).flat(),
              ...(yield* db
                .selectDistinct({ id: BrainEntryTable.repository_id })
                .from(BrainEntryTable)
                .where(like(BrainEntryTable.repository_id, "skill:%"))
                .all()).map((row) => ({ id: row.id.slice("skill:".length) })),
            ].map((row) => row.id),
          ),
        ]
  if (repositories.length === 0) return 0
  const marked = new Set(
    (yield* db
      .select({ id: BrainTombstoneTable.repository_id })
      .from(BrainTombstoneTable)
      .where(and(eq(BrainTombstoneTable.norm_hash, MARKER), inArray(BrainTombstoneTable.repository_id, repositories)))
      .all()).map((row) => row.id),
  )
  const orphaned = repositories.filter((id) => !marked.has(id))
  if (orphaned.length === 0) return 0
  const removed = yield* db.transaction((tx) => eraseScope(tx, orphaned))
  yield* Effect.logInfo("brain learned rows reconciled after an older erase", {
    repositories: orphaned.length,
    entries: removed,
  })
  return orphaned.length
})

/**
 * Deletes skill entries (their brain_skill rows and evidence go by foreign key) with their versions, uses, listing rows
 * and events.
 */
export const remove = Effect.fnUntraced(function* (tx: Handle, repository: string, entries: readonly string[]) {
  if (entries.length === 0) return
  yield* tx
    .delete(BrainEntryTable)
    .where(inArray(BrainEntryTable.id, [...entries]))
    .run()
  yield* Effect.forEach(
    [BrainSkillVersionTable, BrainSkillUseTable, BrainSkillListingTable],
    (table) =>
      tx
        .delete(table)
        .where(and(eq(table.repository_id, repository), inArray(table.entry_id, [...entries])))
        .run(),
    { discard: true },
  )
  yield* tx
    .delete(BrainEventTable)
    .where(inArray(BrainEventTable.entry_id, [...entries]))
    .run()
})

/** Tombstones a key for 180 days, so Vector does not draft it again. */
export const bury = (tx: Handle, repository: string, key: string, now: number) =>
  tx
    .insert(BrainTombstoneTable)
    .values({ repository_id: namespace(repository), norm_hash: tombstone(key), until: now + KEEP.days * DAY })
    .onConflictDoUpdate({
      target: [BrainTombstoneTable.repository_id, BrainTombstoneTable.norm_hash],
      set: { until: now + KEEP.days * DAY },
    })
    .run()

/**
 * Copies a version's text into a new version of a live skill, as a rollback: the version table never changes a row, so
 * a session that loaded an earlier version keeps its bytes.
 */
export const restore = Effect.fnUntraced(function* (
  tx: Handle,
  skill: typeof BrainSkillTable.$inferSelect,
  source: Pick<
    typeof BrainSkillVersionTable.$inferSelect,
    "name" | "description" | "procedure" | "checks" | "commands" | "failure" | "version"
  >,
  input: { readonly actor: "user" | "vector"; readonly at: number },
) {
  const version = (yield* latest(tx, skill.repository_id, skill.skill_key)) + 1
  yield* tx
    .insert(BrainSkillVersionTable)
    .values({
      repository_id: skill.repository_id,
      skill_key: skill.skill_key,
      version,
      entry_id: skill.entry_id,
      session_id: null,
      name: source.name,
      description: source.description,
      procedure: source.procedure,
      checks: source.checks,
      commands: source.commands,
      failure: source.failure,
      actor: input.actor,
      reason: "rollback",
      created_at: input.at,
    })
    .run()
  yield* tx
    .update(BrainSkillTable)
    .set({
      name: source.name,
      description: source.description,
      procedure: source.procedure,
      checks: source.checks,
      commands: source.commands,
      failure: source.failure,
      version,
    })
    .where(eq(BrainSkillTable.entry_id, skill.entry_id))
    .run()
  yield* tx
    .update(BrainEntryTable)
    .set({ body: `${source.name}: ${source.description}`, updated_at: input.at })
    .where(eq(BrainEntryTable.id, skill.entry_id))
    .run()
  yield* tx
    .insert(BrainEventTable)
    .values({
      entry_id: skill.entry_id,
      repository_id: namespace(skill.repository_id),
      at: input.at,
      action: "rollback",
      actor: input.actor,
      detail: { version: source.version, previousVersion: skill.version },
    })
    .run()
  return version
})

/** The highest version a key has had, 0 for none. Versions are numbered per key, across its entries. */
export const latest = Effect.fnUntraced(function* (tx: Handle, repository: string, key: string) {
  const row = yield* tx
    .select({ version: sql<number>`max(${BrainSkillVersionTable.version})` })
    .from(BrainSkillVersionTable)
    .where(and(eq(BrainSkillVersionTable.repository_id, repository), eq(BrainSkillVersionTable.skill_key, key)))
    .get()
  const entries = yield* tx
    .select({ version: sql<number>`max(${BrainSkillTable.version})` })
    .from(BrainSkillTable)
    .where(and(eq(BrainSkillTable.repository_id, repository), eq(BrainSkillTable.skill_key, key)))
    .get()
  return Math.max(row?.version ?? 0, entries?.version ?? 0)
})

// When a skill was last in use: loaded, or put in use (approved, promoted or restored). A draft may wait 60 days for
// review, so its drafting time alone would start the 90-day clock before the skill was ever in use.
function inUse(row: {
  readonly entry: typeof BrainEntryTable.$inferSelect
  readonly skill: typeof BrainSkillTable.$inferSelect
}) {
  return Math.max(row.entry.last_used_at ?? 0, row.skill.approved_at ?? 0, row.entry.created_at)
}

function lift(row: {
  readonly entry: typeof BrainEntryTable.$inferSelect
  readonly skill: typeof BrainSkillTable.$inferSelect
}) {
  return BrainCredit.lift(
    { helpful: row.entry.helpful, harmful: row.entry.harmful, ignored: row.skill.ignored },
    { confidence: row.entry.confidence },
  )
}
