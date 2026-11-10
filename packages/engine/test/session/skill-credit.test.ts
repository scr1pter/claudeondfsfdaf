import fs from "node:fs/promises"
import path from "path"
import { expect } from "bun:test"
import { Effect } from "effect"
import type { Brain } from "@vectordevai/core/brain/brain"
import { BrainSkill } from "@vectordevai/core/brain/skill"
import { Session } from "@/session/session"
import { SessionRevert } from "../../src/session/revert"
import { TestLLMServer } from "../lib/llm-server"
import { CHECK, chat, engine, learned, recover, send, settle, setup, until } from "./learning-fixture"

// Learned skills earn credit by their own check alone (section 5.5), end to end against the fake LLM server: a load
// whose check never ran is ignored, one followed by its check passing passes, and another check passing credits
// nothing. Reverting a run takes back what it credited and withdraws what it drafted.

const it = engine()

// A skill in use: drafted from a run that turned the fixture's typecheck (`CHECK`) green, and approved by the owner.
const approved = Effect.fn("test.approved")(function* (dir: string, place: Brain.Place) {
  yield* recover(dir)
  yield* send(yield* chat(), "The typecheck fails, fix it", { size: "standard" })
  const [skill] = yield* until(learned(place), (list) => list.length > 0)
  yield* (yield* BrainSkill.Service).update(place, skill!.id, { action: "approve" })
  yield* settle()
  return skill!.id
})

const uses = Effect.fn("test.uses")(function* (place: Brain.Place, id: string) {
  const detail = yield* (yield* BrainSkill.Service).get(place, id)
  const skill = detail!.entry.skill!
  return { ...skill.uses, helpful: skill.helpful, harmful: skill.harmful }
})

it.instance(
  "a load whose check never ran is ignored, a load followed by its check passing passes, and another check credits nothing",
  () =>
    Effect.gen(function* () {
      const { dir, place } = yield* setup()
      const llm = yield* TestLLMServer
      const id = yield* approved(dir, place)

      // Loaded, then nothing checked.
      yield* llm.tool("skill", { name: "learned-bun-typecheck-src" })
      yield* llm.text("Looked at it; nothing to change.")
      yield* send(yield* chat(), "Does the typecheck still fail?", { size: "standard" })
      const ignored = yield* until(uses(place, id), (now) => now.ignored === 1)
      expect(ignored).toMatchObject({ loads: 1, passes: 0, fails: 0, ignored: 1, helpful: 0, harmful: 0 })

      // Loaded, then its own check run and passing.
      yield* llm.tool("skill", { name: "learned-bun-typecheck-src" })
      yield* llm.tool("bash", { command: CHECK, description: "Run the check" })
      yield* llm.text("The typecheck passes.")
      yield* send(yield* chat(), "Check the typecheck passes", { size: "standard" })
      const passed = yield* until(uses(place, id), (now) => now.passes === 1)
      expect(passed).toMatchObject({ loads: 2, passes: 1, fails: 0, ignored: 1, helpful: 1, harmful: 0 })

      // Loaded, then another check went green: the skill's own check never ran.
      yield* Effect.promise(() => Bun.write(path.join(dir, "src", "linted.ts"), "export const linted = true\n"))
      yield* llm.tool("skill", { name: "learned-bun-typecheck-src" })
      yield* llm.tool("bash", { command: "bun lint", description: "Run the lint" })
      yield* llm.text("The lint passes.")
      yield* send(yield* chat(), "Run the lint, the typecheck skill may help", { size: "standard" })
      const other = yield* until(uses(place, id), (now) => now.ignored === 2)
      expect(other).toMatchObject({ loads: 3, passes: 1, ignored: 2, helpful: 1, harmful: 0 })
    }),
  { git: true },
  120_000,
)

it.instance(
  "a revert harms what its run passed and withdraws what it drafted, which may be drafted again",
  () =>
    Effect.gen(function* () {
      const { dir, place } = yield* setup()
      const llm = yield* TestLLMServer
      const sessions = yield* Session.Service
      const revert = yield* SessionRevert.Service
      const id = yield* approved(dir, place)

      // One run: the skill's check passes after it loads, and the lint goes green, which drafts a second skill.
      const sessionID = yield* chat()
      yield* llm.tool("skill", { name: "learned-bun-typecheck-src" })
      yield* llm.tool("bash", { command: CHECK, description: "Run the check" })
      yield* recover(dir, { check: "bun lint", fix: "src/linted.ts" })
      yield* send(sessionID, "Get the typecheck and the lint passing", { size: "standard" })
      yield* until(uses(place, id), (now) => now.passes === 1)
      const drafted = yield* until(learned(place), (list) => list.length > 1)
      const lint = drafted.find((entry) => entry.id !== id)!
      expect(lint.status).toBe("proposed")

      const request = (yield* sessions.messages({ sessionID })).find((message) => message.info.role === "user")!
      yield* revert.revert({ sessionID, messageID: request.info.id })
      yield* revert.cleanup(yield* sessions.get(sessionID))
      expect(yield* uses(place, id)).toMatchObject({ passes: 1, reverts: 1, helpful: 0, harmful: 1 })
      // Withdrawn, not rejected: no tombstone keeps it from being drafted again.
      expect((yield* learned(place)).map((entry) => entry.id)).toEqual([id])
      // The revert took the fix back too.
      yield* Effect.promise(() => fs.rm(path.join(dir, "src", "linted.ts"), { force: true }))
      yield* recover(dir, { check: "bun lint", fix: "src/linted.ts" })
      yield* send(yield* chat(), "The lint fails, fix it", { size: "standard" })
      expect((yield* until(learned(place), (list) => list.length > 1)).length).toBe(2)
    }),
  { git: true },
  120_000,
)
