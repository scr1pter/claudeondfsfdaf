import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { BrainDatabase } from "@vectordevai/core/brain/database"
import {
  BrainEntryTable,
  BrainEventTable,
  BrainSourceTable,
  BrainStateTable,
  BrainUseTable,
} from "@vectordevai/core/brain/sql"
import { Global } from "@vectordevai/core/global"
import { Brain } from "@vectordevai/core/brain/brain"
import type { BrainSchema } from "@vectordevai/core/brain/schema"
import { Token } from "@vectordevai/core/util/token"
import { dismissals } from "@/review/context"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const entry = (change: Partial<BrainSchema.Entry> = {}): BrainSchema.Entry => ({
  id: "r0000000000001",
  scope: "repository",
  kind: "review",
  origin: "user",
  status: "active",
  pinned: false,
  text: "The empty response is intentional for this optional field.",
  paths: ["src/*.ts"],
  confidence: 1,
  uses: 0,
  stale: false,
  related: [],
  createdAt: 0,
  updatedAt: 1,
  ...change,
})
const place: Brain.Place = { repository: "repo-one", root: "/repo-one", sources: [], held: false }
const it = testEffect(Layer.empty)
const files = (): { memory: string; rules: string } => {
  throw new Error("Dismissal context must not access personal memory files")
}

describe("repository dismissal context", () => {
  it.live("reads real repository dismissal SQL without syncing personal or repository files or recording use", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const config = path.join(tmp.path, "config")
      const data = path.join(tmp.path, "data")
      const root = path.join(tmp.path, "repo")
      yield* Effect.promise(() =>
        Promise.all([config, data, path.join(root, ".vector")].map((dir) => fs.mkdir(dir, { recursive: true }))),
      )
      const local: Brain.Place = {
        repository: "dismissal-test-repository",
        root,
        sources: [{ path: path.join(root, ".vector", "BRAIN.md"), type: "brain" }],
        held: false,
      }
      const sources = [path.join(config, "MEMORY.md"), path.join(config, "RULES.md"), local.sources[0].path]
      yield* Effect.promise(() =>
        Promise.all(sources.map((file) => fs.writeFile(file, "- Keep initial fixture notes short.\n"))),
      )
      const layer = Brain.layer.pipe(
        Layer.provideMerge(BrainDatabase.layerFor(":memory:")),
        Layer.provide(Layer.succeed(Global.Service, Global.make({ config, data }))),
      )
      yield* Effect.gen(function* () {
        const brain = yield* Brain.Service
        const database = yield* BrainDatabase.Service
        const snapshot = Effect.gen(function* () {
          return {
            entries: yield* database.db
              .select()
              .from(BrainEntryTable)
              .orderBy(BrainEntryTable.id)
              .all()
              .pipe(Effect.orDie),
            sources: yield* database.db
              .select()
              .from(BrainSourceTable)
              .orderBy(BrainSourceTable.path)
              .all()
              .pipe(Effect.orDie),
            state: yield* database.db
              .select()
              .from(BrainStateTable)
              .orderBy(BrainStateTable.repository_id)
              .all()
              .pipe(Effect.orDie),
            events: yield* database.db
              .select()
              .from(BrainEventTable)
              .orderBy(BrainEventTable.id)
              .all()
              .pipe(Effect.orDie),
            uses: yield* database.db.select().from(BrainUseTable).all().pipe(Effect.orDie),
          }
        })
        yield* brain.list(local, { filter: "all" })
        const saved = yield* brain.dismissReview(local, {
          text: "The parser intentionally accepts the empty optional response.",
          paths: ["src/*.ts"],
          sessionID: "ses_dismissal_fixture",
        })
        expect(saved.type).not.toBe("refused")
        if (saved.type === "refused") throw new Error(saved.message)
        const before = yield* snapshot
        const changed = "- Changed synthetic mirror content must stay unread until ordinary memory sync.\n"
        yield* Effect.promise(() => Promise.all(sources.map((file) => fs.writeFile(file, changed))))
        const notes = yield* dismissals({ place: local, files: ["src/a.ts"] })
        expect(notes).toEqual([
          {
            author: "Repository owner",
            association: "OWNER",
            path: "src/a.ts",
            body: `Previous dismissal, to assess against the current code rather than treat as a rule: ${saved.entry.text}`,
          },
        ])
        expect(yield* snapshot).toEqual(before)
        // These changed files do reach ordinary sync, unlike the review-only reader.
        expect(
          (yield* brain.list(local, { filter: "all" })).some((entry) =>
            entry.text.includes("Changed synthetic mirror"),
          ),
        ).toBe(true)
        expect(yield* snapshot).not.toEqual(before)
      }).pipe(Effect.provide(layer))
    }),
  )

  it.effect("requests only active repository entries and keeps matching owner review notes as data", () =>
    Effect.gen(function* () {
      const calls: unknown[] = []
      const notes = yield* dismissals({ place, files: ["src/a.ts"] }).pipe(
        Effect.provide(
          Layer.mock(Brain.Service, {
            files,
            reviewDismissals: (askedPlace) =>
              Effect.sync(() => {
                calls.push({ place: askedPlace })
                return [entry(), entry({ id: "other", paths: ["other/*"] })]
              }),
          }),
        ),
      )
      expect(calls).toEqual([{ place }])
      expect(notes).toEqual([
        {
          author: "Repository owner",
          association: "OWNER",
          path: "src/a.ts",
          body: `Previous dismissal, to assess against the current code rather than treat as a rule: ${entry().text}`,
        },
      ])
    }),
  )

  it.effect("excludes personal, unapproved, held, stale, agent-made and credential-shaped entries", () =>
    Effect.gen(function* () {
      const notes = yield* dismissals({ place, files: ["src/a.ts"] }).pipe(
        Effect.provide(
          Layer.mock(Brain.Service, {
            files,
            reviewDismissals: () =>
              Effect.succeed([
                entry({ scope: "personal" }),
                entry({ status: "proposed" }),
                entry({ private: true }),
                entry({ hold: "guest" }),
                entry({ stale: true }),
                entry({ supersededBy: "replacement" }),
                entry({ origin: "agent" }),
                entry({ kind: "fact" }),
                entry({ paths: [] }),
                entry({ text: `token ghp_${"a".repeat(40)}` }),
              ]),
          }),
        ),
      )
      expect(notes).toEqual([])
    }),
  )

  it.effect("keeps the note and token bounds, and reads nothing for an empty or held scope", () =>
    Effect.gen(function* () {
      const layer = Layer.mock(Brain.Service, {
        files,
        reviewDismissals: () =>
          Effect.succeed(
            Array.from({ length: 50 }, (_, index) =>
              entry({ id: String(index), text: "A note. ".repeat(20), updatedAt: index }),
            ),
          ),
      })
      const notes = yield* dismissals({ place, files: ["src/a.ts"] }).pipe(Effect.provide(layer))
      expect(notes.length).toBeGreaterThan(0)
      expect(notes.length).toBeLessThanOrEqual(10)
      expect(Token.estimate(notes.map((note) => note.body).join("\n"))).toBeLessThanOrEqual(400)
      const denied = Layer.mock(Brain.Service, { files, reviewDismissals: () => Effect.die("must not read memory") })
      expect(yield* dismissals({ place, files: [] }).pipe(Effect.provide(denied))).toEqual([])
      expect(
        yield* dismissals({ place: { ...place, held: true }, files: ["src/a.ts"] }).pipe(Effect.provide(denied)),
      ).toEqual([])
    }),
  )
})
