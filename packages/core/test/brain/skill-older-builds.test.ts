import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { and, eq, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainDatabase } from "@vectordevai/core/brain/database"
import { BrainSkill } from "@vectordevai/core/brain/skill"
import { SkillStore } from "@vectordevai/core/brain/skill-store"
import { BrainEntryTable, BrainTombstoneTable } from "@vectordevai/core/brain/sql"
import { BrainWorkflow } from "@vectordevai/core/brain/workflow"
import { Global } from "@vectordevai/core/global"
import { tmpdir } from "../fixture/tmpdir"

// Older builds share brain.db (section 4.5). Skill entries live under "skill:<repository>", which every memory query
// of this and older builds filters away, and a marker tombstone tells this build when an older one erased the
// repository's memory, so it can finish that erase.

type Setup = {
  readonly brain: Brain.Interface
  readonly skills: BrainSkill.Interface
  readonly workflow: BrainWorkflow.Interface
  readonly db: BrainDatabase.Database
  readonly place: Brain.Place
}

async function open<A>(dir: string, file: string, body: (setup: Setup) => Effect.Effect<A>) {
  const config = path.join(dir, "config")
  const data = path.join(dir, "data")
  const root = path.join(dir, "repo")
  await Promise.all([config, data, root].map((folder) => fs.mkdir(folder, { recursive: true })))
  const base = Brain.layer.pipe(
    Layer.provideMerge(BrainDatabase.layerFor(file).pipe(Layer.fresh)),
    Layer.provide(Layer.succeed(Global.Service, Global.make({ config, data }))),
  )
  return await Effect.runPromise(
    Effect.gen(function* () {
      return yield* body({
        brain: yield* Brain.Service,
        skills: yield* BrainSkill.Service,
        workflow: yield* BrainWorkflow.Service,
        db: (yield* BrainDatabase.Service).db,
        place: { repository: "repo-1", root, sources: [], held: false },
      })
    }).pipe(Effect.provide(Layer.mergeAll(BrainSkill.layer, BrainWorkflow.layer).pipe(Layer.provideMerge(base)))),
  )
}

const run = <A>(body: (setup: Setup) => Effect.Effect<A>) =>
  (async () => {
    await using tmp = await tmpdir()
    return await open(tmp.path, ":memory:", body)
  })()

// A skill in use, taught in session ses_a, that names the words the queries below ask for.
const learn = (setup: Setup) =>
  Effect.gen(function* () {
    const draft = BrainSkill.draft({
      sessionID: "ses_a",
      requestID: "msg_a",
      signal: "recovered",
      check: { command: "bun typecheck", target: "bun typecheck", failure: "TS2322" },
      commands: ["git diff packages/core"],
      edited: ["packages/core/src/brain.ts"],
      read: [],
      closing: "",
      at: 1,
    })!
    const result = yield* setup.skills.propose(setup.place, draft, {
      origin: "agent",
      sessionID: "ses_a",
      requestID: "msg_a",
      evidence: { type: "run", command: "bun typecheck", requestID: "msg_a", verified: true },
    })
    if (result.type === "refused") return yield* Effect.die(result.message)
    yield* setup.skills.update(setup.place, result.entry.id, { action: "approve" })
    return result.entry
  })

const observation: BrainWorkflow.Observation = {
  sessionID: "ses_a",
  requestID: "msg_w",
  at: Date.now(),
  tier: "standard",
  effortTier: "standard",
  agent: "build",
  providerID: "p",
  modelID: "m",
  effort: "default",
  effortSource: "size",
  subagents: 0,
  subagentModels: {},
  judgeRounds: 0,
  outcome: "pass",
  costKinds: {},
  steps: 1,
  unpricedSteps: 0,
  tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0 },
  partial: false,
}

describe("Learned skills and older builds", () => {
  test("no memory query a build shares sees a skill: list, digest, recall, candidates, search, get, lines, forget", async () => {
    const result = await run((setup) =>
      Effect.gen(function* () {
        const skill = yield* learn(setup)
        const query = "bun typecheck fails in packages core brain"
        const ids = (entries: readonly { readonly id: string }[]) => entries.map((entry) => entry.id)
        return {
          skill,
          list: ids(yield* setup.brain.list(setup.place, { filter: "all" })),
          learned: ids(yield* setup.brain.list(setup.place, { filter: "learned" })),
          digest: (yield* setup.brain.digest(setup.place, { personal: true, index: true })).ids,
          recall: (yield* setup.brain.recall(setup.place, { query, budget: 500, personal: true })).ids,
          candidates: ids(yield* setup.brain.candidates(setup.place, { query, personal: true })),
          search: ids(yield* setup.brain.search(setup.place, { query, personal: true })),
          get: yield* setup.brain.get(setup.place, skill.id, { personal: true }),
          lines: [...(yield* setup.brain.lines(setup.place, [skill.id], { personal: true })).keys()],
          forget: yield* setup.brain.forget(setup.place, skill.id),
          still: (yield* setup.skills.get(setup.place, skill.id))?.entry.status,
        }
      }),
    )
    expect(result.list).toEqual([])
    expect(result.learned).toEqual([])
    expect(result.digest).toEqual([])
    expect(result.recall).toEqual([])
    expect(result.candidates).toEqual([])
    expect(result.search).toEqual([])
    expect(result.get).toBeUndefined()
    expect(result.lines).toEqual([])
    expect(result.forget).toBe("not-found")
    expect(result.still).toBe("active")
  })

  test("tidying's cap, merge and decay of memory leave skills alone, and a session erase never forgets one as memory", async () => {
    const result = await run((setup) =>
      Effect.gen(function* () {
        const skill = yield* learn(setup)
        const now = Date.now()
        // A full repository: 300 learned entries in use, the cap.
        yield* setup.db
          .insert(BrainEntryTable)
          .values(
            Array.from({ length: 300 }, (_, index) => ({
              id: `m${String(index).padStart(5, "0")}`,
              scope: "repository" as const,
              repository_id: "repo-1",
              kind: "lesson" as const,
              origin: "agent" as const,
              status: "active" as const,
              body: `Lesson number ${index} about the widget ${index}`,
              paths: [],
              terms: JSON.stringify({ lesson: 1, [`widget${index}`]: 1 }),
              norm_hash: `hash${index}`,
              confidence: 0.8,
              uses: 1,
              created_at: now,
              updated_at: now,
              related: [],
            })),
          )
          .run()
          .pipe(Effect.orDie)
        // The skill's own words, learned as a lesson in another session: tidying must not merge the two.
        const lesson = yield* setup.brain.propose(setup.place, {
          kind: "lesson",
          text: skill.text,
          scope: "repository",
          origin: "agent",
          sessionID: "ses_l",
        })
        const consolidated = yield* setup.brain.consolidate(setup.place, { force: true })
        const erased = yield* setup.db
          .select()
          .from(BrainTombstoneTable)
          .where(eq(BrainTombstoneTable.repository_id, "repo-1"))
          .all()
          .pipe(Effect.orDie)
        const active = yield* setup.db
          .select({ n: sql<number>`count(*)` })
          .from(BrainEntryTable)
          .where(and(eq(BrainEntryTable.repository_id, "repo-1"), eq(BrainEntryTable.status, "active")))
          .get()
          .pipe(Effect.orDie)
        yield* setup.brain.eraseSession(setup.place, "ses_a")
        const tombstones = yield* setup.db
          .select({ repository: BrainTombstoneTable.repository_id, hash: BrainTombstoneTable.norm_hash })
          .from(BrainTombstoneTable)
          .all()
          .pipe(Effect.orDie)
        return { skill, lesson: lesson.type, consolidated, erased, active: active?.n, tombstones }
      }),
    )
    // One past the cap is archived, and it is a lesson: the skill never counts toward it.
    expect(result.lesson).toBe("added")
    expect(result.active).toBe(300)
    expect(result.consolidated.merged).toBe(0)
    expect(result.erased.map((row) => row.norm_hash)).toEqual([SkillStore.MARKER])
    // The session erase took the skill back under its own namespace and forgot nothing as memory.
    expect(result.tombstones).toEqual([
      { repository: "repo-1", hash: SkillStore.MARKER },
      { repository: "skill:repo-1", hash: SkillStore.tombstone(result.skill.skill!.key) },
    ])
  })

  test("the marker is a tombstone with no terms, which never keeps the agent from learning anything", async () => {
    const result = await run((setup) =>
      Effect.gen(function* () {
        yield* learn(setup)
        const marker = yield* setup.db
          .select()
          .from(BrainTombstoneTable)
          .where(eq(BrainTombstoneTable.norm_hash, SkillStore.MARKER))
          .get()
          .pipe(Effect.orDie)
        const lesson = yield* setup.brain.propose(setup.place, {
          kind: "lesson",
          text: "Run the brain tests from packages/core",
          scope: "repository",
          origin: "agent",
          sessionID: "ses_b",
        })
        return { marker, lesson }
      }),
    )
    expect(result.marker).toEqual({
      repository_id: "repo-1",
      norm_hash: SkillStore.MARKER,
      until: SkillStore.FOREVER,
      terms: null,
      polarity: null,
    })
    expect(result.lesson.type).toBe("added")
  })

  test("an older build's erase of the repository or of everything is finished the next time this build opens brain.db", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "brain.db")
    const seed = (repository: string) =>
      open(tmp.path, file, (setup) =>
        Effect.gen(function* () {
          const place = { ...setup.place, repository }
          const scoped = { ...setup, place }
          const skill = yield* learn(scoped)
          yield* setup.skills.loaded(place, {
            id: skill.id,
            version: 1,
            sessionID: `ses_${repository}`,
            requestID: "msg_b",
          })
          yield* setup.skills.store(place, `ses_${repository}`, [
            {
              id: skill.id,
              name: skill.skill!.name,
              description: skill.skill!.description,
              version: 1,
              private: false,
            },
          ])
          yield* setup.workflow.record(place, observation)
        }),
      )
    const counts = () => {
      const db = new Database(file, { readonly: true })
      const count = (table: string) =>
        (
          db
            .query(`SELECT repository_id AS id, count(*) AS n FROM ${table} GROUP BY repository_id ORDER BY 1`)
            .all() as {
            id: string
            n: number
          }[]
        ).map((row) => `${row.id}:${row.n}`)
      const result = Object.fromEntries(
        [
          "brain_skill",
          "brain_skill_version",
          "brain_skill_use",
          "brain_skill_listing",
          "brain_workflow_run",
          "brain_entry",
        ].map((table) => [table, count(table)]),
      )
      db.close()
      return result
    }
    await seed("repo-1")
    await seed("repo-2")
    await seed("repo-3")
    const seeded = counts()
    // What an older build's erase(repository) of repo-1 deletes: its learned entries, events and tombstones (the
    // marker with them), never the "skill:repo-1" rows it cannot see; and its erase of everything for repo-2's
    // learned entries (skill entries among them, so brain_skill goes by foreign key) and tombstones.
    const older = new Database(file)
    older.run("PRAGMA foreign_keys = ON")
    older.run("DELETE FROM brain_entry WHERE origin IN ('agent','user','import') AND repository_id IN ('repo-1')")
    older.run("DELETE FROM brain_event WHERE repository_id IN ('repo-1')")
    older.run("DELETE FROM brain_tombstone WHERE repository_id IN ('repo-1')")
    older.run("DELETE FROM brain_entry WHERE origin IN ('agent','user','import') AND repository_id = 'skill:repo-2'")
    older.run("DELETE FROM brain_tombstone WHERE repository_id IN ('repo-2', 'skill:repo-2')")
    older.close()
    // Opening the skills, with no write at all, finishes both.
    await open(tmp.path, file, (setup) => setup.skills.list(setup.place, "all"))
    const after = counts()
    expect(seeded.brain_skill).toEqual(["repo-1:1", "repo-2:1", "repo-3:1"])
    expect(after).toEqual({
      brain_skill: ["repo-3:1"],
      brain_skill_version: ["repo-3:1"],
      brain_skill_use: ["repo-3:1"],
      brain_skill_listing: ["repo-3:1"],
      brain_workflow_run: ["repo-3:1"],
      brain_entry: ["skill:repo-3:1"],
    })
  })
})
