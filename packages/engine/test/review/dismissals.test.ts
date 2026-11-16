import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import type { BrainSchema } from "@vectordevai/core/brain/schema"
import { Token } from "@vectordevai/core/util/token"
import { dismissals } from "@/review/context"
import { testEffect } from "../lib/effect"

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
  it.effect("requests only active repository entries and keeps matching owner review notes as data", () =>
    Effect.gen(function* () {
      const calls: unknown[] = []
      const notes = yield* dismissals({ place, files: ["src/a.ts"] }).pipe(
        Effect.provide(
          Layer.mock(Brain.Service, {
            files,
            list: (askedPlace, input) =>
              Effect.sync(() => {
                calls.push({ place: askedPlace, input })
                return [entry(), entry({ id: "other", paths: ["other/*"] })]
              }),
          }),
        ),
      )
      expect(calls).toEqual([{ place, input: { scope: "repository", filter: "active" } }])
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
            list: () =>
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
        list: () =>
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
      const denied = Layer.mock(Brain.Service, { files, list: () => Effect.die("must not read memory") })
      expect(yield* dismissals({ place, files: [] }).pipe(Effect.provide(denied))).toEqual([])
      expect(
        yield* dismissals({ place: { ...place, held: true }, files: ["src/a.ts"] }).pipe(Effect.provide(denied)),
      ).toEqual([])
    }),
  )
})
