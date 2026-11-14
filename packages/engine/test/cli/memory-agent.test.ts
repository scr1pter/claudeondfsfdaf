import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import yargs from "yargs"
import { Effect } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { BrainSkill } from "@vectordevai/core/brain/skill"
import { BrainWorkflow } from "@vectordevai/core/brain/workflow"
import { ChildEnvironment } from "@vectordevai/core/child-environment"
import { MemoryCommand } from "../../src/cli/cmd/memory"
import { AppRuntime } from "../../src/effect/app-runtime"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceStore } from "../../src/project/instance-store"
import { Instruction } from "../../src/session/instruction"
import { tmpdir } from "../fixture/fixture"

// Owner gates (section 2.1): every `vector memory` command that changes memory, documents, learned skills, workflow
// insights or how Vector learns refuses under the agent marker, which an agent's shell and Vector's own terminal carry,
// and leaves everything as it was; read-only commands stay open. Without the marker each gated command gets past the
// gate. The commands run in this process as the CLI runs them, in a repository of their own.

const GATE = "Vector's agents cannot"
const NOTES = "# Notes\n\nThe client MUST retry at most 3 times after a 429 response.\n"
const IMPORT = [
  "## Preferences",
  "- I prefer tabs over spaces",
  "- I prefer bullet points over prose",
  "",
  "## Skills",
  "",
  ...["src", "lib"].flatMap((area) => [
    `### learned-bun-typecheck-${area}`,
    "",
    `When bun typecheck fails in ${area}: steps that made it pass here before.`,
    "",
    "- checks: `bun typecheck`",
    `- commands: \`git diff ${area}\``,
    `- paths: \`${area}/a.ts\``,
    "",
    "```markdown",
    "## Steps",
    "1. Run `bun typecheck`.",
    `2. Read ${area}/a.ts and fix the type.`,
    "```",
    "",
  ]),
].join("\n")

let repository: Awaited<ReturnType<typeof tmpdir>>
const cwd = process.cwd()
const marker = process.env[ChildEnvironment.AGENT_MARKER]

beforeAll(async () => {
  repository = await tmpdir({ git: true, trusted: true, config: { formatter: false, lsp: false } })
  await fs.writeFile(path.join(repository.path, "notes.md"), NOTES)
  await fs.writeFile(path.join(repository.path, "memory.md"), IMPORT)
  process.chdir(repository.path)
})

afterAll(async () => {
  process.chdir(cwd)
  if (marker === undefined) delete process.env[ChildEnvironment.AGENT_MARKER]
  else process.env[ChildEnvironment.AGENT_MARKER] = marker
  await repository[Symbol.asyncDispose]()
})

// `vector memory …` in this process, as an agent (marked) or as the owner. Resolves to the failure's message, if any.
const run = async (args: readonly string[], marked: boolean) => {
  if (marked) process.env[ChildEnvironment.AGENT_MARKER] = "ses_agent"
  if (!marked) delete process.env[ChildEnvironment.AGENT_MARKER]
  return yargs(["memory", ...args])
    .command(MemoryCommand)
    .strict()
    .exitProcess(false)
    .fail((message, error) => {
      throw error ?? new Error(message)
    })
    .parseAsync()
    .then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
}

// Everything the gated commands could change, read in the repository's instance as the commands read it.
const snapshot = () =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      const ctx = yield* store.load({ directory: repository.path })
      return yield* Effect.gen(function* () {
        const instruction = yield* Instruction.Service
        const brain = yield* Brain.Service
        const skills = yield* BrainSkill.Service
        const knowledge = yield* BrainKnowledge.Service
        const workflow = yield* BrainWorkflow.Service
        const place = yield* instruction.place()
        return {
          place,
          memory: yield* brain.list(place, { filter: "all" }),
          personal: yield* brain.list(place, { filter: "all", scope: "personal" }),
          skills: yield* skills.list(place, "all"),
          learn: yield* brain.learnSettings(),
          learning: yield* brain.learning(),
          knowledge: yield* knowledge.settings(place),
          documents: yield* knowledge.documents(place, { personal: true }),
          paused: (yield* knowledge.model(place)).paused,
          // Runs by setting; their weights decay with time, so they are left out.
          workflow: (yield* workflow.insights(place)).tiers.map((tier) => ({
            tier: tier.tier,
            arms: tier.arms.map((item) => ({ arm: item.arm, rows: item.rows })),
          })),
          mode: (yield* workflow.insights(place)).mode,
        }
      }).pipe(Effect.provideService(InstanceRef, ctx), Effect.ensuring(store.dispose(ctx)))
    }),
  )

const record = (place: Brain.Place) =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      const workflow = yield* BrainWorkflow.Service
      yield* workflow.record(place, {
        sessionID: "ses_run",
        requestID: "msg_run",
        at: Date.now(),
        tier: "thorough",
        effortTier: "thorough",
        agent: "build",
        providerID: "anthropic",
        modelID: "claude-x",
        effort: "high",
        effortSource: "size",
        subagents: 0,
        subagentModels: {},
        judgeRounds: 0,
        outcome: "pass",
        signal: "recovered",
        costUsd: 0.5,
        costKinds: { priced: 2 },
        steps: 2,
        unpricedSteps: 0,
        tokens: { input: 100, output: 10, reasoning: 0, cacheRead: 0 },
        partial: false,
      })
    }),
  )

// Every gated command, with the ids of what it would change. Each refuses under the marker before it reads anything.
const gated = (ids: { entry: string; waiting: string; skill: string; other: string }) => [
  ["add", "Prefer small commits"],
  ["edit", ids.entry, "Prefer small, focused commits"],
  ["pin", ids.entry],
  ["unpin", ids.entry],
  ["approve", ids.waiting],
  ["reject", ids.waiting],
  ["undo", ids.entry],
  ["tidy"],
  ["learning", "off"],
  ["import", "memory.md"],
  ["doc", "add", "notes.md"],
  ["doc", "reindex"],
  ["doc", "approve", "1"],
  ["doc", "reject", "1"],
  ["doc", "distill", "1"],
  ["doc", "forget", "1"],
  ["review", "resolve", "v1", "dismiss"],
  ["repo-docs", "off"],
  ["model", "pause"],
  ["model", "resume"],
  ["model", "remove"],
  ["model", "install", "--from", "no-such-folder"],
  ["model", "download", "--yes"],
  ["skills", "edit", ids.skill, "--description", "When bun typecheck fails in src: run it and read the error."],
  ["skills", "approve", ids.skill],
  ["skills", "rollback", ids.skill, "1"],
  ["skills", "share", ids.skill, "--yes"],
  ["skills", "restore", ids.skill],
  ["skills", "archive", ids.skill],
  ["skills", "undo", ids.skill],
  ["skills", "reject", ids.other],
  ["skills", "learning", "auto"],
  ["skills", "drafter", "always"],
  ["skills", "forget", ids.skill],
  ["workflow", "explore", "on"],
  ["workflow", "mode", "off"],
  ["workflow", "reset", "--yes"],
  ["forget", ids.entry],
  ["erase", "--yes"],
  ["erase", "--everywhere", "--yes"],
]

describe("owner-only memory commands", () => {
  test("refuse under the agent marker and change nothing; read-only ones stay open; the owner gets past every gate", async () => {
    expect(await run(["add", "Use pnpm in this repository"], false)).toBeUndefined()
    expect(await run(["import", "memory.md"], false)).toBeUndefined()
    const before = await snapshot()
    await record(before.place)
    const seeded = await snapshot()
    const ids = {
      entry: seeded.memory.find((entry) => entry.text === "Use pnpm in this repository")!.id,
      waiting: [...seeded.memory, ...seeded.personal].find((entry) => entry.text === "I prefer tabs over spaces")!.id,
      skill: seeded.skills.find((entry) => entry.skill?.name === "learned-bun-typecheck-src")!.id,
      other: seeded.skills.find((entry) => entry.skill?.name === "learned-bun-typecheck-lib")!.id,
    }
    expect(seeded.skills.map((entry) => entry.status)).toEqual(["proposed", "proposed"])
    expect(seeded.workflow.find((tier) => tier.tier === "thorough")?.arms).toHaveLength(1)

    // As an agent: every gated command is refused by the gate, and nothing changes.
    const commands = gated(ids)
    for (const args of commands) expect([args, await run(args, true)]).toEqual([args, expect.stringContaining(GATE)])
    // Erasing without --yes is refused by the gate too, before it asks to confirm.
    expect(await run(["erase"], true)).toContain(GATE)
    expect(JSON.stringify(await snapshot())).toBe(JSON.stringify(seeded))

    // Reading stays open to the agent.
    for (const args of [
      ["list", "--json"],
      ["show", ids.entry],
      ["learning"],
      ["repo-docs"],
      ["skills", "--all", "--json"],
      ["skills", "show", ids.skill],
      ["workflow", "--json"],
    ])
      expect([args, await run(args, true)]).toEqual([args, undefined])

    // As the owner: no command is stopped by the gate. Some still fail for their own reasons (nothing held, no
    // such folder, no --yes without a terminal), which is not the gate's doing.
    for (const args of commands) {
      const failed = await run(args, false)
      expect([args, failed?.includes(GATE) ?? false]).toEqual([args, false])
    }
    const after = await snapshot()
    expect(after.memory.find((entry) => entry.id === ids.entry)).toBeUndefined()
    expect(after.skills.map((entry) => entry.id)).not.toContain(ids.skill)
    expect(after.workflow.flatMap((tier) => tier.arms)).toEqual([])
    expect(
      await fs.readFile(path.join(repository.path, ".vector/skills/learned-bun-typecheck-src/SKILL.md"), "utf8"),
    ).toContain("name: learned-bun-typecheck-src")
  }, 300_000)
})
