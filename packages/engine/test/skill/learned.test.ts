import { expect } from "bun:test"
import { Effect } from "effect"
import type { Brain } from "@vectordevai/core/brain/brain"
import { BrainSkill } from "@vectordevai/core/brain/skill"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { LearnedSkill } from "../../src/skill/learned"
import { reloadInstance, TestInstance } from "../fixture/fixture"
import { engine, ref, setup } from "../session/learning-fixture"

// What a session's learned skills listing shows (section 5.4): chosen once, on its first step, and kept in brain.db, so
// a later step and a reloaded instance show the same lines; after that it only loses lines, when a guest joins, the
// model may train on prompts or a skill is forgotten. Vectorscope's reviewers, Vector's helpers and subagents get none,
// and a line names a skill, never where it is kept.

const it = engine()

// A skill in use, as the owner approved it after a run turned `check` green while changing `edited`.
const active = Effect.fn("test.active")(function* (
  place: Brain.Place,
  input: { readonly check: string; readonly edited: string; readonly private?: boolean },
) {
  const skills = yield* BrainSkill.Service
  const draft = BrainSkill.draft({
    sessionID: "ses_learned",
    requestID: `msg_${input.check.replaceAll(" ", "_")}`,
    signal: "recovered",
    check: { command: input.check, target: BrainSkill.target(input.check), failure: "error: it failed" },
    commands: ["git status"],
    edited: [input.edited],
    read: [],
    closing: "",
    at: Date.now(),
  })!
  const proposed = yield* skills.propose(place, draft, {
    origin: "import",
    ...(input.private ? { private: true } : {}),
  })
  if (proposed.type === "refused") return yield* Effect.die(new Error(proposed.message))
  yield* skills.update(place, proposed.entry.id, { action: "approve" })
  return { id: proposed.entry.id, name: draft.name }
})

const viewer = Effect.fn("test.viewer")(function* (session?: Parameters<Session.Interface["create"]>[0]) {
  const sessions = yield* Session.Service
  return {
    session: yield* sessions.create({ title: "Learned", ...session }),
    agent: yield* (yield* Agent.Service).get("build"),
    model: yield* (yield* Provider.Service).getModel(ref.providerID, ref.modelID),
    guest: false,
  }
})

it.instance(
  "the listing is chosen once and kept in brain.db: a later step and a reloaded instance show the same lines",
  () =>
    Effect.gen(function* () {
      const { place } = yield* setup()
      const learned = yield* LearnedSkill.Service
      const typecheck = yield* active(place, { check: "bun typecheck", edited: "src/types/index.ts" })
      const input = yield* viewer()
      const first = yield* learned.listing({ ...input, query: "the typecheck fails in the types", first: true })
      expect(first.map((item) => item.name)).toEqual([typecheck.name])
      // The line names the skill and says it is learned; it holds no id and no path.
      expect(first[0]).toEqual({
        name: typecheck.name,
        description: first[0]!.description,
        location: "learned",
        content: "",
      })
      expect(JSON.stringify(first)).not.toContain(typecheck.id)

      // A skill that bears on the later request more is not added: the listing was chosen.
      yield* active(place, { check: "bun lint", edited: "src/lint/index.ts" })
      const later = yield* learned.listing({ ...input, query: "now the lint fails", first: false })
      expect(later).toEqual(first)
      yield* reloadInstance({ directory: (yield* TestInstance).directory })
      const reloaded = yield* (yield* LearnedSkill.Service).listing({ ...input, query: "the lint", first: false })
      expect(reloaded).toEqual(first)
    }),
  { git: true },
  60_000,
)

it.instance(
  "Vectorscope's reviewers, Vector's helpers and subagents get no learned skills",
  () =>
    Effect.gen(function* () {
      const { place } = yield* setup()
      const learned = yield* LearnedSkill.Service
      yield* active(place, { check: "bun typecheck", edited: "src/types/index.ts" })
      const root = yield* viewer()
      const query = { query: "the typecheck fails in the types", first: true }
      for (const session of [
        { internal: "vectorscope.review" },
        { internal: "autocomplete" },
        { parentID: root.session.id },
      ])
        expect(yield* learned.listing({ ...(yield* viewer(session)), ...query })).toEqual([])
      expect(yield* learned.listing({ ...root, ...query })).toHaveLength(1)
    }),
  { git: true },
  60_000,
)

it.instance(
  "a guest joining mid-session drops the listing, and the skill no longer loads",
  () =>
    Effect.gen(function* () {
      const { place } = yield* setup()
      const learned = yield* LearnedSkill.Service
      const skill = yield* active(place, { check: "bun typecheck", edited: "src/types/index.ts" })
      const input = yield* viewer()
      expect(yield* learned.listing({ ...input, query: "the typecheck fails", first: true })).toHaveLength(1)
      expect((yield* learned.load({ ...input, name: skill.name }))?.id).toBe(skill.id)
      yield* (yield* FreeModelGuests.Service).mark(input.session.id)
      const guest = { ...input, guest: yield* (yield* FreeModelGuests.Service).marked(input.session.id) }
      expect(yield* learned.listing({ ...guest, query: "the typecheck fails", first: false })).toEqual([])
      expect(yield* learned.load({ ...guest, name: skill.name })).toBeUndefined()
    }),
  { git: true },
  60_000,
)

it.instance(
  "a model that may train on prompts gets no skill learned beside a private document",
  () =>
    Effect.gen(function* () {
      const { place } = yield* setup()
      const learned = yield* LearnedSkill.Service
      const shared = yield* active(place, { check: "bun typecheck", edited: "src/types/index.ts" })
      const secret = yield* active(place, { check: "bun lint", edited: "src/types/lint.ts", private: true })
      const input = yield* viewer()
      const query = "the typecheck and the lint fail in the types"
      const listed = yield* learned.listing({ ...input, query, first: true })
      expect(listed.map((item) => item.name).toSorted()).toEqual([secret.name, shared.name].toSorted())
      const training = {
        ...input,
        model: { ...input.model, freeModel: { dataPolicy: "training" } } as unknown as Provider.Model,
      }
      expect((yield* learned.listing({ ...training, query, first: false })).map((item) => item.name)).toEqual([
        shared.name,
      ])
      expect(yield* learned.load({ ...training, name: secret.name })).toBeUndefined()
    }),
  { git: true },
  60_000,
)

it.instance(
  "a forgotten skill drops out of the listing and no longer loads",
  () =>
    Effect.gen(function* () {
      const { place } = yield* setup()
      const learned = yield* LearnedSkill.Service
      const skill = yield* active(place, { check: "bun typecheck", edited: "src/types/index.ts" })
      const input = yield* viewer()
      expect(yield* learned.listing({ ...input, query: "the typecheck fails", first: true })).toHaveLength(1)
      yield* (yield* BrainSkill.Service).forget(place, skill.id)
      expect(yield* learned.listing({ ...input, query: "the typecheck fails", first: false })).toEqual([])
      expect(yield* learned.load({ ...input, name: skill.name })).toBeUndefined()
    }),
  { git: true },
  60_000,
)
