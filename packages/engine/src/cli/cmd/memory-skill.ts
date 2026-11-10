import { EOL } from "os"
import path from "path"
import { Effect } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import type { BrainSchema } from "@vectordevai/core/brain/schema"
import { BrainSkill } from "@vectordevai/core/brain/skill"
import { Instruction } from "@/session/instruction"
import { LearnedSkill } from "@/skill/learned"
import { effectCmd, fail } from "../effect-cmd"
import { CliOwnerGate } from "../owner-gate"
import { UI } from "../ui"

// `vector memory skills`: the skills Vector drafted for the repository in the current directory after a run turned a
// failing check green, as Settings > Memory > Skills shows them. Listing and reading them is open to the agent; every
// command that approves, changes, shares or forgets one, or changes how Vector learns them, is the owner's.

export const MemorySkillsCommand = effectCmd({
  command: "skills",
  describe: "see and review the skills Vector learned in this repository",
  builder: (yargs) =>
    yargs
      .command(MemorySkillShowCommand)
      .command(decide("approve", "put a draft in use", "Approved"))
      .command(decide("reject", "delete a draft; Vector will not draft it again", "Rejected"))
      .command(decide("undo", "take back the version in use; the one it replaced comes back", "Undid"))
      .command(decide("archive", "stop listing a skill to the agent", "Archived"))
      .command(decide("restore", "bring back a skill you put away, as a new version", "Restored"))
      .command(MemorySkillForgetCommand)
      .command(MemorySkillEditCommand)
      .command(MemorySkillRollbackCommand)
      .command(MemorySkillShareCommand)
      .command(MemorySkillLearningCommand)
      .command(MemorySkillDrafterCommand)
      .option("review", { describe: "only drafts waiting for your review", type: "boolean", default: false })
      .option("archived", { describe: "only skills put away, replaced or shared", type: "boolean", default: false })
      .option("all", { describe: "every skill, whatever its state", type: "boolean", default: false })
      .option("json", { describe: "print JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.memory.skills")(function* (args) {
    const memory = yield* where
    const entries = yield* memory.skills.list(
      memory.place,
      args.all ? "all" : args.review ? "review" : args.archived ? "archived" : "active",
    )
    if (args.json) return print(entries)
    const settings = yield* memory.brain.learnSettings()
    if (entries.length === 0)
      UI.println(args.review ? "No skill waits for your review." : "Vector has not learned a skill here yet.")
    for (const entry of entries) UI.println(line(entry))
    UI.empty()
    UI.println(
      UI.Style.TEXT_DIM +
        `Learning: ${LEARNING[settings.skills]}. Drafter: ${DRAFTER[settings.skillDrafter]}. ${SHOW}` +
        UI.Style.TEXT_NORMAL,
    )
  }),
})

export const MemorySkillShowCommand = effectCmd({
  command: "show <skill>",
  describe: "show a skill: its steps, checks and commands, versions and how its loads fared",
  builder: (yargs) =>
    yargs
      .positional("skill", { describe: "the skill's id or name", type: "string", demandOption: true })
      .option("json", { describe: "print JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.memory.skills.show")(function* (args) {
    const memory = yield* where
    const id = yield* resolve(args.skill)
    const detail = yield* memory.skills.get(memory.place, id)
    if (!detail?.entry.skill) return yield* fail(`No learned skill ${args.skill} here.`)
    if (args.json) return print(detail)
    const skill = detail.entry.skill
    UI.println(line(detail.entry))
    UI.println(`  ${skill.description}`)
    UI.println(`  Checks: ${skill.checks.join(", ") || "none"}`)
    UI.println(`  Commands: ${skill.commands.join(", ") || "none"}`)
    UI.println(
      `  Loaded ${skill.uses.loads}, passed ${skill.uses.passes}, failed ${skill.uses.fails}, check not run ${skill.uses.ignored}, reverted ${skill.uses.reverts}`,
    )
    UI.empty()
    UI.println(skill.procedure)
    if (skill.failure) {
      UI.empty()
      UI.println(UI.Style.TEXT_DIM + "What failed last time:" + UI.Style.TEXT_NORMAL)
      UI.println(skill.failure)
      if (skill.instructionLikeFailure)
        UI.println(UI.Style.TEXT_WARNING + "The error text reads like instructions." + UI.Style.TEXT_NORMAL)
    }
    UI.empty()
    for (const version of detail.versions)
      UI.println(
        `  v${version.version} ${day(version.createdAt)} ${version.reason} by ${version.actor}${version.version === skill.version ? " (current)" : ""}`,
      )
    for (const item of detail.evidence)
      UI.println(`  ${day(item.createdAt)} | ${item.type}${item.command ? `: ${item.command}` : ""}`)
  }),
})

const decide = (action: "approve" | "reject" | "undo" | "archive" | "restore", describe: string, done: string) =>
  effectCmd({
    command: `${action} <id>`,
    describe,
    builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
    handler: Effect.fn(`Cli.memory.skills.${action}`)(function* (args) {
      yield* CliOwnerGate.refuse(`${action} learned skills`)
      yield* change(args.id, { action }, done)
    }),
  })

export const MemorySkillForgetCommand = effectCmd({
  command: "forget <id>",
  describe: "delete a skill and every version of it; Vector will not draft it again",
  builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.memory.skills.forget")(function* (args) {
    yield* CliOwnerGate.refuse("forget learned skills")
    const memory = yield* where
    if ((yield* memory.skills.forget(memory.place, args.id)) === "not-found")
      return yield* fail(`No learned skill ${args.id} here.`)
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Forgot ${args.id}` + UI.Style.TEXT_NORMAL)
  }),
})

export const MemorySkillEditCommand = effectCmd({
  command: "edit <id>",
  describe: "change a skill's description or steps; the edit is a new version, checked like a draft",
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true })
      .option("description", { describe: "the new description", type: "string" })
      .option("procedure-file", { describe: "a Markdown file with the new steps", type: "string" }),
  handler: Effect.fn("Cli.memory.skills.edit")(function* (args) {
    yield* CliOwnerGate.refuse("edit learned skills")
    if (args.description === undefined && args.procedureFile === undefined)
      return yield* fail("Give --description, --procedure-file or both.")
    const file = args.procedureFile === undefined ? undefined : Bun.file(path.resolve(args.procedureFile))
    if (file && !(yield* Effect.promise(() => file.exists()))) return yield* fail(`No file ${args.procedureFile}.`)
    yield* change(
      args.id,
      {
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(file ? { procedure: yield* Effect.promise(() => file.text()) } : {}),
      },
      "Saved a new version of",
    )
  }),
})

// The version is named `number`: yargs keeps `version` for the CLI's own flag, which prints Vector's version.
export const MemorySkillRollbackCommand = effectCmd({
  command: "rollback <id> <number>",
  describe: "go back to an earlier version's text, as a new version",
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true })
      .positional("number", { describe: "the version to go back to", type: "number", demandOption: true }),
  handler: Effect.fn("Cli.memory.skills.rollback")(function* (args) {
    yield* CliOwnerGate.refuse("roll back learned skills")
    yield* change(args.id, { action: "rollback", version: args.number }, `Went back to version ${args.number} of`)
  }),
})

// Sharing writes one file the owner commits: the steps only, checked against their personal memory first. The file
// changes the repository's settings, which ask to be trusted again, from a terminal outside Vector.
export const MemorySkillShareCommand = effectCmd({
  command: "share <id>",
  describe: "write a skill you approved to .vector/skills for your team, after you read the file",
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true })
      .option("force", { describe: "replace a SKILL.md already there", type: "boolean", default: false })
      .option("yes", { describe: "write it without asking first", type: "boolean", default: false }),
  handler: Effect.fn("Cli.memory.skills.share")(function* (args) {
    yield* CliOwnerGate.refuse("share learned skills")
    const memory = yield* where
    const ready = yield* memory.skills.shareable(memory.place, args.id)
    if ("refused" in ready) return yield* fail(ready.message)
    UI.println(UI.Style.TEXT_DIM + `.vector/skills/${ready.entry.skill?.name}/SKILL.md:` + UI.Style.TEXT_NORMAL)
    process.stdout.write(ready.text.replaceAll("\n", EOL))
    UI.empty()
    if (!args.yes) {
      if (!process.stdin.isTTY) return yield* fail("Run again with --yes to write it.")
      const { confirm, isCancel } = yield* Effect.promise(() => import("@clack/prompts"))
      const answer = yield* Effect.promise(() => confirm({ message: "Write this file to the repository?" }))
      if (isCancel(answer) || !answer) return UI.println("Nothing was written.")
    }
    const learned = yield* LearnedSkill.Service
    const result = yield* learned.share(memory.place, args.id, { force: args.force })
    if (result.type === "refused") return yield* fail(result.message)
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Wrote ${result.path}` + UI.Style.TEXT_NORMAL)
    UI.println(`Read it with \`git status\` and \`git diff\`, then commit it with \`git add ${result.path}\`.`)
    UI.println(
      "This changes the repository's settings: run `vector trust approve` in a terminal outside Vector to trust them again.",
    )
  }),
})

export const MemorySkillLearningCommand = effectCmd({
  command: "learning <mode>",
  describe:
    "review: drafts wait for you (the default). auto: a draft goes live after a second matching success in another session. off: Vector drafts none",
  builder: (yargs) => yargs.positional("mode", { choices: ["review", "auto", "off"] as const, demandOption: true }),
  handler: Effect.fn("Cli.memory.skills.learning")(function* (args) {
    yield* CliOwnerGate.refuse("change how Vector learns skills")
    const brain = yield* Brain.Service
    const settings = yield* brain.setLearnSettings({ skills: args.mode })
    UI.println(`Skill learning: ${LEARNING[settings.skills]}.`)
  }),
})

export const MemorySkillDrafterCommand = effectCmd({
  command: "drafter <mode>",
  describe:
    "whether a model may word a skill's draft: off, local-only (the default, only with Vector Local on) or always (sends a run's commands, file names and a short redacted error excerpt to your model provider)",
  builder: (yargs) =>
    yargs.positional("mode", { choices: ["off", "local-only", "always"] as const, demandOption: true }),
  handler: Effect.fn("Cli.memory.skills.drafter")(function* (args) {
    yield* CliOwnerGate.refuse("change the skill drafter")
    const brain = yield* Brain.Service
    const settings = yield* brain.setLearnSettings({ skillDrafter: args.mode })
    UI.println(`Skill drafter: ${DRAFTER[settings.skillDrafter]}.`)
    UI.println(UI.Style.TEXT_DIM + PRIVACY + UI.Style.TEXT_NORMAL)
  }),
})

const LEARNING: Record<BrainSchema.SkillLearning, string> = {
  review: "drafts wait for your review",
  auto: "a draft goes live after a second matching success",
  off: "off",
}

const DRAFTER: Record<BrainSchema.SkillDrafter, string> = {
  off: "plain code only",
  "local-only": "a model only with Vector Local on",
  always: "a model may word drafts",
}

const SHOW = "Show one with `vector memory skills show <id>`."

const PRIVACY =
  "Learned skills and workflow insights are stored only in brain.db on this computer. Vector sends them nowhere, except that the optional skill drafter, when you set it to Always, sends one run's commands, file names and a short redacted error excerpt to your model provider. By default it runs only with Vector Local on."

const where = Effect.gen(function* () {
  const instruction = yield* Instruction.Service
  return { brain: yield* Brain.Service, skills: yield* BrainSkill.Service, place: yield* instruction.place() }
})

const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}${EOL}`)

// A skill by its id, or by its name: the one in use, else the newest of that name.
const resolve = Effect.fnUntraced(function* (input: string) {
  if (BrainSkill.ID.test(input)) return input
  const memory = yield* where
  const named = (yield* memory.skills.list(memory.place, "all")).filter((entry) => entry.skill?.name === input)
  return (named.find((entry) => entry.status === "active") ?? named[0])?.id ?? input
})

const change = Effect.fnUntraced(function* (id: string, update: BrainSkill.SkillChange, done: string) {
  const memory = yield* where
  const result = yield* memory.skills.update(memory.place, id, update)
  if (!result) return yield* fail(`No learned skill ${id} here.`)
  if (result.type === "refused") return yield* fail(result.message)
  UI.println(UI.Style.TEXT_SUCCESS_BOLD + `${done} ${id}` + UI.Style.TEXT_NORMAL)
})

function day(at: number) {
  return new Date(at).toISOString().slice(0, 10)
}

function line(entry: BrainSchema.Entry) {
  const skill = entry.skill
  const marks = [
    skill ? `v${skill.version}` : undefined,
    entry.status === "active" ? undefined : entry.status,
    entry.hold ? `held: ${entry.hold}` : undefined,
    skill?.approvedBy === "vector" ? "approved by Vector" : undefined,
    skill?.fading ? "fading" : undefined,
    entry.stale ? "stale" : undefined,
    entry.private ? "private" : undefined,
    skill?.sharedPath ? `shared to ${skill.sharedPath}` : undefined,
  ].filter((mark): mark is string => mark !== undefined)
  return `${UI.Style.TEXT_HIGHLIGHT}${entry.id}${UI.Style.TEXT_NORMAL} ${skill?.name ?? entry.text}${marks.length ? `${UI.Style.TEXT_DIM} (${marks.join(", ")})${UI.Style.TEXT_NORMAL}` : ""}`
}
