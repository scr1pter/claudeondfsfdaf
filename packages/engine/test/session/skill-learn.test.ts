import fs from "node:fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { BrainSkill } from "@vectordevai/core/brain/skill"
import { ChildEnvironment } from "@vectordevai/core/child-environment"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { MemoryEvent } from "@vectordevai/schema/memory-event"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { SessionSkillLearn } from "../../src/session/skill-learn"
import { Session } from "../../src/session/session"
import { reply, TestLLMServer } from "../lib/llm-server"
import { CHECK, chat, engine, learned, recover, send, settle, setup, until } from "./learning-fixture"

// Learned skills drafted end to end (section 5.1), against the fake LLM server with no paid model call: a run whose
// check went from failing to passing drafts a skill that waits for the owner, with the command as the agent typed it.
// Nothing is drafted from a guest's session, a check that deploys or releases, a run that followed a skill it loaded,
// or under --pure; a session that took in outside content or an untrusted repository's drafts are held, and only the
// owner's setting lets the small model word a draft, never for held content and never past the session's next prompt.

const it = engine()
const pure = engine({ pure: true })

// The model drafter's request carries its instructions.
const drafting = (hit: { readonly body: Record<string, unknown> }) =>
  JSON.stringify(hit.body).includes("You write a short procedure")

const drafter = Effect.fn("test.drafter")(function* (setting: Brain.LearnSettings["skillDrafter"]) {
  const brain = yield* Brain.Service
  yield* brain.setLearnSettings({ skillDrafter: setting })
  yield* Effect.addFinalizer(() => brain.setLearnSettings({ skillDrafter: "local-only" }))
})

const WORDED = JSON.stringify({
  description: "When the typecheck fails in src: add the file it misses.",
  steps: [`Run \`${CHECK}\``, "Read `src/app.ts`", "Add `src/fixed.ts`", `Run \`${CHECK}\` again`],
})

it.instance(
  "a check that went from failing to passing drafts a skill for review, with the command as the agent typed it",
  () =>
    Effect.gen(function* () {
      const { dir, place } = yield* setup()
      const events = yield* EventV2Bridge.Service
      const announced: unknown[] = []
      const unsubscribe = yield* events.listen((event) => {
        if (event.type === MemoryEvent.Learned.type) announced.push(event.data)
        return Effect.void
      })
      yield* recover(dir)
      const sessionID = yield* chat()
      yield* send(sessionID, "The typecheck fails, fix it", { size: "standard" })
      const [skill] = yield* until(learned(place), (list) => list.length > 0)
      yield* until(
        Effect.sync(() => announced.length),
        (count) => count > 0,
      )
      yield* unsubscribe
      // The chip under the request ("Drafted a skill for your review") reads the draft from the owner's skill routes,
      // so the event names its id and the request only.
      const [request] = (yield* (yield* Session.Service).messages({ sessionID }).pipe(Effect.orDie)).filter(
        (message) => message.info.role === "user",
      )
      expect(announced).toEqual([{ sessionID, entryIDs: [skill!.id], messageID: request!.info.id }])
      expect(skill?.status).toBe("proposed")
      expect(skill?.skill?.name).toBe("learned-bun-typecheck-src")
      expect(skill?.skill?.checks).toEqual([CHECK])
      expect(skill?.skill?.commands).toEqual(["git status --short"])
      expect(skill?.skill?.drafter).toBe("rules")
      expect(skill?.paths).toEqual(["src/fixed.ts", "src/app.ts"])
      expect(skill?.skill?.procedure).toContain(`\`${CHECK}\``)
      // Default settings: the model drafter runs only with Vector Local on, which it is not.
      expect((yield* (yield* TestLLMServer).hits).some(drafting)).toBe(false)
    }),
  { git: true },
  90_000,
)

it.instance(
  "a session an invited guest is in drafts nothing",
  () =>
    Effect.gen(function* () {
      const { dir, place } = yield* setup()
      const sessionID = yield* chat()
      yield* (yield* FreeModelGuests.Service).mark(sessionID)
      yield* recover(dir)
      yield* send(sessionID, "The typecheck fails, fix it", { size: "standard" })
      yield* settle()
      expect(yield* learned(place)).toEqual([])
    }),
  { git: true },
  90_000,
)

it.instance(
  "a session that read outside content drafts a quarantined skill, and its trace never reaches a model",
  () =>
    Effect.gen(function* () {
      const { dir, place } = yield* setup()
      yield* drafter("always")
      // A program Vector does not know may print anyone's text.
      yield* recover(dir, { helper: "learning-probe-not-installed --version" })
      yield* send(yield* chat(), "The typecheck fails, fix it", { size: "standard" })
      const [skill] = yield* until(learned(place), (list) => list.length > 0)
      yield* settle()
      expect(skill?.status).toBe("quarantined")
      expect(skill?.hold).toBe("web")
      expect((yield* (yield* TestLLMServer).hits).some(drafting)).toBe(false)
    }),
  { git: true },
  90_000,
)

it.instance(
  "a session that read a document from outside drafts a held skill, though the owner let the document in",
  () =>
    Effect.gen(function* () {
      const { dir, place } = yield* setup()
      const knowledge = yield* BrainKnowledge.Service
      const added = yield* knowledge.add(place, {
        type: "text",
        name: "issue.md",
        text: "# Typecheck failure\n\nThe typecheck fails since the fixed module went missing from src.\n",
        origin: "agent",
        hold: "web",
      })
      if (added.type === "refused") return yield* Effect.die(new Error(added.message))
      yield* knowledge.wait(place, added.document.id, "searchable", 10_000)
      yield* knowledge.update(place, added.document.id, { action: "approve" })
      yield* (yield* TestLLMServer).tool("memory", { action: "get", id: added.document.id })
      yield* recover(dir)
      yield* send(yield* chat(), "The typecheck fails, fix it", { size: "standard" })
      const [skill] = yield* until(learned(place), (list) => list.length > 0)
      expect(skill?.status).toBe("quarantined")
      expect(skill?.hold).toBe("web")
    }),
  { git: true },
  90_000,
)

it.instance(
  "a check that releases is never a skill's check, so its recovery drafts nothing",
  () =>
    Effect.gen(function* () {
      const { dir, place } = yield* setup()
      yield* recover(dir, { check: "bun run build:release", fix: "src/released.ts" })
      yield* send(yield* chat(), "The release build fails, fix it", { size: "standard" })
      yield* settle()
      expect(yield* learned(place)).toEqual([])
    }),
  { git: true },
  90_000,
)

it.instance(
  "a run that loaded a skill and did what it says drafts nothing; one that went its own way drafts a new version",
  () =>
    Effect.gen(function* () {
      const { dir, place } = yield* setup()
      const skills = yield* BrainSkill.Service
      yield* recover(dir)
      yield* send(yield* chat(), "The typecheck fails, fix it", { size: "standard" })
      const [first] = yield* until(learned(place), (list) => list.length > 0)
      yield* skills.update(place, first!.id, { action: "approve" })
      yield* settle()

      // The same failure again, fixed the way the skill says.
      yield* Effect.promise(() => fs.rm(path.join(dir, "src", "fixed.ts")))
      yield* recover(dir, { load: "learned-bun-typecheck-src" })
      yield* send(yield* chat(), "The typecheck fails again, fix it", { size: "standard" })
      yield* settle()
      expect((yield* learned(place)).map((entry) => entry.id)).toEqual([first!.id])

      // Fixed another way: other files, other commands. The owner approved the skill, so its new version waits for them.
      yield* Effect.promise(() => fs.rm(path.join(dir, "src", "fixed.ts")))
      yield* Effect.promise(() => Bun.write(path.join(dir, "src", "types.ts"), "export type T = 1\n"))
      yield* recover(dir, { load: "learned-bun-typecheck-src", read: "src/types.ts", helper: "git diff --stat" })
      yield* send(yield* chat(), "The typecheck fails once more, fix it", { size: "standard" })
      const all = yield* until(learned(place), (list) => list.length > 1)
      const next = all.find((entry) => entry.id !== first!.id)
      expect(next?.status).toBe("proposed")
      expect(next?.skill?.key).toBe("bun-typecheck-src")
      expect(next?.skill?.version).toBe(2)
      expect(all.find((entry) => entry.id === first!.id)?.status).toBe("active")
    }),
  { git: true },
  120_000,
)

it.instance(
  "an untrusted repository's draft is held for review",
  () =>
    Effect.gen(function* () {
      const { dir, place } = yield* setup({ trust: false })
      expect(place.held).toBe(true)
      yield* recover(dir)
      yield* send(yield* chat(), "The typecheck fails, fix it", { size: "standard" })
      const [skill] = yield* until(learned(place), (list) => list.length > 0)
      expect(skill?.status).toBe("quarantined")
      expect(skill?.hold).toBe("untrusted-repository")
    }),
  { git: true },
  90_000,
)

it.instance(
  "a Vector an agent started holds its drafts as a subagent's, and two of its sessions never promote one in auto mode",
  () =>
    Effect.gen(function* () {
      const { dir, place } = yield* setup()
      const brain = yield* Brain.Service
      // `vector run` from an agent's shell: this process carries the marker every child of an agent's process gets.
      const marker = process.env[ChildEnvironment.AGENT_MARKER]
      process.env[ChildEnvironment.AGENT_MARKER] = "ses_outer"
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (marker === undefined) delete process.env[ChildEnvironment.AGENT_MARKER]
          else process.env[ChildEnvironment.AGENT_MARKER] = marker
          yield* brain.setLearnSettings({ skills: "review" })
        }),
      )
      yield* brain.setLearnSettings({ skills: "auto" })
      yield* recover(dir)
      yield* send(yield* chat(), "The typecheck fails, fix it", { size: "standard" })
      const [first] = yield* until(learned(place), (list) => list.length > 0)
      expect(first?.status).toBe("quarantined")
      expect(first?.hold).toBe("subagent")

      // Another session of the same nested Vector does the same thing: no second, independent sighting.
      yield* Effect.promise(() => fs.rm(path.join(dir, "src", "fixed.ts")))
      yield* recover(dir)
      yield* send(yield* chat(), "The typecheck fails again, fix it", { size: "standard" })
      yield* settle()
      const all = yield* learned(place)
      expect(all.map((entry) => [entry.id, entry.status, entry.skill?.approvedBy])).toEqual([
        [first!.id, "quarantined", undefined],
      ])
    }),
  { git: true },
  120_000,
)

it.instance(
  "with the drafter set to always, the small model words the draft, locked to what the run showed",
  () =>
    Effect.gen(function* () {
      const { dir, place } = yield* setup()
      const llm = yield* TestLLMServer
      yield* drafter("always")
      yield* recover(dir)
      yield* llm.textMatch(drafting, WORDED)
      yield* send(yield* chat(), "The typecheck fails, fix it", { size: "standard" })
      const [skill] = yield* until(learned(place), (list) => list.length > 0)
      expect(skill?.skill?.drafter).toBe("model")
      expect(skill?.skill?.description).toBe("When the typecheck fails in src: add the file it misses.")
      expect(skill?.skill?.checks).toEqual([CHECK])
      // Model drafts wait for the owner, whatever the mode.
      expect(skill?.status).toBe("proposed")
      // The trace went as data, with nothing of the conversation but the run's commands and files.
      const sent = JSON.stringify((yield* llm.hits).find(drafting)?.body)
      expect(sent).toContain("run_trace")
      expect(sent).not.toContain("The typecheck fails, fix it")
    }),
  { git: true },
  90_000,
)

it.instance(
  "the session's next prompt cancels the drafter, and the run keeps the plain draft",
  () =>
    Effect.gen(function* () {
      const { dir, place } = yield* setup()
      const llm = yield* TestLLMServer
      yield* drafter("always")
      yield* recover(dir)
      yield* llm.pushMatch(drafting, reply().hang())
      const sessionID = yield* chat()
      yield* send(sessionID, "The typecheck fails, fix it", { size: "standard" })
      yield* until(llm.hits, (hits) => hits.some(drafting))
      expect(yield* learned(place)).toEqual([])
      yield* llm.text("Done.")
      yield* send(sessionID, "Thanks, anything else?")
      const [skill] = yield* until(learned(place), (list) => list.length > 0)
      expect(skill?.skill?.drafter).toBe("rules")
    }),
  { git: true },
  90_000,
)

it.instance(
  "the model drafter's request counts against the run that launched it, as the model learner's does",
  () =>
    Effect.gen(function* () {
      // Priced at $1 per million tokens, so the drafter's million input tokens cost $1.
      const { dir, place, llm } = yield* setup({ model: { cost: { input: 1, output: 1 } } })
      const guard = yield* SpendGuard.Service
      yield* drafter("always")
      yield* recover(dir)
      const gate = Promise.withResolvers<void>()
      yield* llm.pushMatch(
        drafting,
        reply().text(WORDED).usage({ input: 1_000_000, output: 0 }).wait(gate.promise).stop(),
      )
      const sessionID = yield* chat()
      yield* send(sessionID, "The typecheck fails, fix it", { size: "standard" })
      yield* until(llm.hits, (hits) => hits.some(drafting))
      const ran = yield* guard.snapshot(sessionID)
      gate.resolve()
      const [skill] = yield* until(learned(place), (list) => list.length > 0)
      expect(skill?.skill?.drafter).toBe("model")
      const after = yield* guard.snapshot(sessionID)
      expect(after?.steps).toBe((ran?.steps ?? 0) + 1)
      expect((after?.spentUsd ?? 0) - (ran?.spentUsd ?? 0)).toBeCloseTo(1)
    }),
  { git: true },
  90_000,
)

it.instance(
  "a run that stopped after its snapshot keeps the plain draft, and the model drafter sends nothing",
  () =>
    Effect.gen(function* () {
      const { dir, place, llm } = yield* setup()
      const sessions = yield* Session.Service
      const skillLearn = yield* SessionSkillLearn.Service
      // The run drafts by rules; the drafter is then called again on its turn, as the run's end would call it.
      yield* drafter("off")
      yield* recover(dir)
      const sessionID = yield* chat()
      yield* send(sessionID, "The typecheck fails, fix it", { size: "standard" })
      yield* until(learned(place), (list) => list.length > 0)
      yield* settle()
      yield* drafter("always")
      const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
      const user = (yield* sessions.messages({ sessionID }).pipe(Effect.orDie)).find(
        (message) => message.info.role === "user",
      )!
      const taught = new Map([[user.info.id, { message: user, tier: "standard" as const }]])
      const recorded: string[] = []
      const spend = (stopped?: SpendGuard.Stop): SessionSkillLearn.Spend => ({
        captured: {
          record: (usageID) =>
            Effect.sync(() => {
              recorded.push(usageID)
              return { state: "ok" as const }
            }),
          stopped: Effect.succeed(stopped),
          release: Effect.void,
        },
        costKind: () => Effect.succeed("priced" as const),
      })

      const stopped = yield* skillLearn.run(session, taught, undefined, spend({ reason: "cap", message: "" }))
      expect(stopped).toBeDefined()
      yield* stopped!
      expect((yield* llm.hits).some(drafting)).toBe(false)
      expect(recorded).toEqual([])

      // Not stopped, the same turn's drafter asks the model, and its request is charged to the captured run.
      yield* llm.textMatch(drafting, WORDED, { usage: { input: 1_000, output: 10 } })
      const going = yield* skillLearn.run(session, taught, undefined, spend())
      yield* going!
      expect((yield* llm.hits).some(drafting)).toBe(true)
      expect(recorded).toHaveLength(1)
    }),
  { git: true },
  90_000,
)

it.instance(
  "a session drafts at most three skills",
  () =>
    Effect.gen(function* () {
      const { dir, place } = yield* setup()
      const sessionID = yield* chat()
      const checks = [
        ["bun typecheck", "src/fixed.ts"],
        ["bun lint", "src/linted.ts"],
        ["bun run test:unit", "src/tested.ts"],
        ["bun verify", "src/verified.ts"],
      ] as const
      for (const [check, fix] of checks) {
        yield* recover(dir, { check, fix })
        yield* send(sessionID, `${check} fails, fix it`, { size: "standard" })
        yield* settle()
      }
      expect((yield* learned(place)).map((entry) => entry.skill?.checks[0]).toSorted()).toEqual([
        "bun lint",
        "bun run test:unit",
        "bun typecheck",
      ])
    }),
  { git: true },
  150_000,
)

pure.instance(
  "--pure drafts nothing",
  () =>
    Effect.gen(function* () {
      const { dir, place } = yield* setup()
      yield* recover(dir)
      yield* send(yield* chat(), "The typecheck fails, fix it", { size: "standard" })
      yield* settle()
      expect(yield* learned(place)).toEqual([])
    }),
  { git: true },
  90_000,
)

describe("the model drafter's gate", () => {
  const run = (state: Partial<SpendGuard.Run>) => state as SpendGuard.Run
  const allowed = { setting: "always", local: false, held: false, mayTrain: false } as const

  test("runs where the owner allows it", () => {
    expect(SessionSkillLearn.drafts(allowed)).toBe(true)
    expect(SessionSkillLearn.drafts({ ...allowed, setting: "local-only", local: true })).toBe(true)
  })

  test("is skipped when off, local-only without Vector Local, held, on a model that may train, or past a budget", () => {
    expect(SessionSkillLearn.drafts({ ...allowed, setting: "off" })).toBe(false)
    expect(SessionSkillLearn.drafts({ ...allowed, setting: "local-only", local: false })).toBe(false)
    expect(SessionSkillLearn.drafts({ ...allowed, held: true })).toBe(false)
    expect(SessionSkillLearn.drafts({ ...allowed, mayTrain: true })).toBe(false)
    expect(SessionSkillLearn.drafts({ ...allowed, run: run({ warned: true }) })).toBe(false)
    expect(
      SessionSkillLearn.drafts({ ...allowed, run: run({ warned: false, stopped: { reason: "cap", message: "" } }) }),
    ).toBe(false)
    expect(SessionSkillLearn.drafts({ ...allowed, run: run({ warned: false }) })).toBe(true)
  })
})
