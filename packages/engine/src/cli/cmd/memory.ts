import type { Argv } from "yargs"
import { EOL } from "os"
import path from "path"
import { Effect } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainErase } from "@vectordevai/core/brain/erase"
import { BrainExport } from "@vectordevai/core/brain/export"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import type { BrainSchema } from "@vectordevai/core/brain/schema"
import { BrainSkill } from "@vectordevai/core/brain/skill"
import { ResearchStore } from "@vectordevai/core/research/store"
import { Instruction } from "@/session/instruction"
import { cmd } from "./cmd"
import {
  MemoryDocCommand,
  MemoryLinksCommand,
  MemoryModelCommand,
  MemoryRepoDocsCommand,
  MemoryReviewCommand,
} from "./memory-doc"
import { MemorySkillsCommand } from "./memory-skill"
import { MemoryWorkflowCommand } from "./memory-workflow"
import { effectCmd, fail } from "../effect-cmd"
import { CliOwnerGate } from "../owner-gate"
import { UI } from "../ui"

// `vector memory`: the same controls as Settings > Memory, for the repository in the current directory and for the
// user. Memory stays on this computer; nothing here sends it anywhere. What changes memory or how Vector learns is the
// owner's to run (CliOwnerGate): an agent's shell may read memory but not approve, edit or erase it.

export const MemoryCommand = cmd({
  command: "memory",
  describe: "see and manage what Vector remembers for this repository and for you",
  builder: (yargs: Argv) =>
    yargs
      .command(MemoryListCommand)
      .command(MemorySearchCommand)
      .command(MemoryShowCommand)
      .command(MemoryAddCommand)
      .command(MemoryEditCommand)
      .command(MemoryPinCommand)
      .command(MemoryUnpinCommand)
      .command(MemoryApproveCommand)
      .command(MemoryRejectCommand)
      .command(MemoryUndoCommand)
      .command(MemoryForgetCommand)
      .command(MemoryTidyCommand)
      .command(MemoryEraseCommand)
      .command(MemoryLearningCommand)
      .command(MemoryExportCommand)
      .command(MemoryImportCommand)
      .command(MemoryDocCommand)
      .command(MemoryLinksCommand)
      .command(MemoryReviewCommand)
      .command(MemoryRepoDocsCommand)
      .command(MemoryModelCommand)
      .command(MemorySkillsCommand)
      .command(MemoryWorkflowCommand)
      .demandCommand(),
  async handler() {},
})

// The brain and where the current directory sits in it.
const where = Effect.gen(function* () {
  const instruction = yield* Instruction.Service
  return { brain: yield* Brain.Service, place: yield* instruction.place() }
})

const scopeOption = <T>(yargs: Argv<T>) =>
  yargs.option("personal", { describe: "your own memory, for every repository", type: "boolean", default: false })

export const MemoryListCommand = effectCmd({
  command: ["list", "ls"],
  describe: "list memory: rules, saved preferences and what Vector learned",
  builder: (yargs) =>
    scopeOption(yargs)
      .option("review", { describe: "only what waits for your review", type: "boolean", default: false })
      .option("archived", { describe: "only archived and replaced entries", type: "boolean", default: false })
      .option("all", { describe: "every entry, whatever its state", type: "boolean", default: false })
      .option("learned", {
        describe: "what Vector put in use on its own, newest first",
        type: "boolean",
        default: false,
      })
      .option("json", { describe: "print JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.memory.list")(function* (args) {
    const memory = yield* where
    const entries = yield* memory.brain.list(memory.place, {
      filter: args.all
        ? "all"
        : args.learned
          ? "learned"
          : args.review
            ? "review"
            : args.archived
              ? "archived"
              : "active",
      ...(args.personal ? { scope: "personal" as const } : {}),
    })
    if (args.json) return void process.stdout.write(`${JSON.stringify(entries, null, 2)}${EOL}`)
    if (entries.length === 0)
      return UI.println(
        args.review
          ? "Nothing waits for your review."
          : args.learned
            ? "Vector has not learned anything on its own yet."
            : "Nothing in memory yet.",
      )
    for (const entry of entries) UI.println(line(entry))
    const stats = yield* memory.brain.stats(memory.place)
    UI.empty()
    UI.println(
      UI.Style.TEXT_DIM +
        `${stats.active} active, ${stats.review} to review, ${stats.archived} archived. The always-loaded part costs about ${stats.digestTokens} tokens per request.` +
        UI.Style.TEXT_NORMAL,
    )
  }),
})

export const MemorySearchCommand = effectCmd({
  command: "search <query..>",
  describe: "search memory the way the agent does",
  builder: (yargs) => yargs.positional("query", { type: "string", array: true, demandOption: true }),
  handler: Effect.fn("Cli.memory.search")(function* (args) {
    const memory = yield* where
    const entries = yield* memory.brain.list(memory.place, { query: args.query.join(" ") })
    if (entries.length === 0) return UI.println("Nothing in memory matches.")
    for (const entry of entries.slice(0, 20)) UI.println(line(entry))
  }),
})

export const MemoryShowCommand = effectCmd({
  command: "show <id>",
  describe: "show one entry with its evidence",
  builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.memory.show")(function* (args) {
    const memory = yield* where
    const detail = yield* memory.brain.get(memory.place, args.id, { personal: true })
    if (!detail) return yield* missing(args.id)
    UI.println(line(detail.entry))
    for (const item of detail.evidence)
      UI.println(
        `  ${new Date(item.createdAt).toISOString().slice(0, 10)} | ${item.type}${item.path ? ` ${item.path}` : ""}${item.quote ? `: "${item.quote}"` : ""}${item.command ? `: ${item.command}` : ""}`,
      )
    if (detail.related.length) UI.println(`  Related: ${detail.related.map((item) => item.id).join(", ")}`)
  }),
})

export const MemoryAddCommand = effectCmd({
  command: "add <text..>",
  describe: "save something for Vector to remember",
  builder: (yargs) =>
    scopeOption(yargs)
      .positional("text", { type: "string", array: true, demandOption: true })
      .option("kind", {
        describe: "what it is",
        choices: ["preference", "decision", "lesson", "fact", "term"] as const,
        default: "lesson" as const,
      }),
  handler: Effect.fn("Cli.memory.add")(function* (args) {
    yield* CliOwnerGate.refuse("add to your memory")
    const memory = yield* where
    const result = yield* memory.brain.propose(memory.place, {
      kind: args.kind,
      text: args.text.join(" "),
      scope: args.personal ? "personal" : "repository",
      origin: "user",
      evidence: { type: "user" },
    })
    if (result.type === "refused") return yield* fail(result.message)
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Saved ${result.entry.id}` + UI.Style.TEXT_NORMAL)
    // Memory never replaces an entry on its own, so a similar one stays in use beside this; say which, to edit or forget.
    if ("related" in result && result.related)
      UI.println(
        `  Similar: ${line(result.related)}\n  To replace it, run: vector memory edit ${result.related.id} <text>`,
      )
  }),
})

export const MemoryEditCommand = effectCmd({
  command: "edit <id> <text..>",
  describe: "change the text of an entry Vector learned",
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true })
      .positional("text", { type: "string", array: true, demandOption: true }),
  handler: Effect.fn("Cli.memory.edit")(function* (args) {
    yield* CliOwnerGate.refuse("edit your memory")
    yield* change(args.id, { text: args.text.join(" ") }, "Updated")
  }),
})

const simple = (name: string, describe: string, update: Brain.Change, done: string) =>
  effectCmd({
    command: `${name} <id>`,
    describe,
    builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
    handler: Effect.fn(`Cli.memory.${name}`)(function* (args) {
      yield* CliOwnerGate.refuse(`${name} memory`)
      yield* change(args.id, update, done)
    }),
  })

export const MemoryPinCommand = simple("pin", "keep an entry in every request", { pinned: true }, "Pinned")
export const MemoryUnpinCommand = simple("unpin", "stop pinning an entry", { pinned: false }, "Unpinned")
export const MemoryApproveCommand = simple(
  "approve",
  "let Vector use an entry that waited for your review",
  { action: "approve" },
  "Approved",
)
export const MemoryRejectCommand = simple(
  "reject",
  "delete an entry that waited for your review",
  { action: "reject" },
  "Rejected",
)
export const MemoryUndoCommand = simple(
  "undo",
  "take back what Vector learned; it will not learn it again",
  { action: "undo" },
  "Undid",
)

const change = Effect.fnUntraced(function* (id: string, update: Brain.Change, done: string) {
  const memory = yield* where
  const result = yield* memory.brain.update(memory.place, id, update, "user")
  if (!result || (result.type === "refused" && result.reason === "skill-entry")) return yield* missing(id)
  if (result.type === "refused") return yield* fail(result.message)
  UI.println(UI.Style.TEXT_SUCCESS_BOLD + `${done} ${id}` + UI.Style.TEXT_NORMAL)
})

export const MemoryForgetCommand = effectCmd({
  command: "forget <id>",
  describe: "delete an entry for good; Vector will not learn it again",
  builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.memory.forget")(function* (args) {
    yield* CliOwnerGate.refuse("forget memory")
    const memory = yield* where
    const result = yield* memory.brain.forget(memory.place, args.id)
    if (result === "not-found") return yield* missing(args.id)
    if (result === "file-entry") return yield* fail("That entry comes from a file you wrote; change it in that file.")
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Forgot ${args.id}` + UI.Style.TEXT_NORMAL)
  }),
})

export const MemoryTidyCommand = effectCmd({
  command: "tidy",
  describe: "merge duplicates, drop what waited too long for review, archive what goes unused",
  handler: Effect.fn("Cli.memory.tidy")(function* () {
    yield* CliOwnerGate.refuse("tidy memory")
    const memory = yield* where
    const report = yield* memory.brain.consolidate(memory.place, { force: true })
    UI.println(
      `Merged ${report.merged}, archived ${report.archived}, dropped ${report.dropped}, marked ${report.stale} stale.`,
    )
  }),
})

/** What `vector memory erase` takes, as it asks before erasing. Deep research goes with a repository's memory. */
export function eraseWarning(scope: BrainErase.Scope) {
  const what =
    scope === "all"
      ? "everything Vector learned, in every repository and about you, and every Deep research run"
      : scope === "personal"
        ? "what Vector learned about you"
        : "what Vector learned in this repository, its failure memory, skills, workflow insights and Deep research runs included"
  return `This erases ${what}. Run it again with --yes to confirm.`
}

/** What `vector memory erase` says it took. */
export function erasedMessage(erased: BrainErase.Erased) {
  const entries = `Erased ${erased.entries} entr${erased.entries === 1 ? "y" : "ies"}`
  return erased.runs === 0 ? entries : `${entries} and ${erased.runs} research run${erased.runs === 1 ? "" : "s"}`
}

// The same erase as Settings > Memory's, through BrainErase, so research does not outlive the memory it belongs to.
export const MemoryEraseCommand = effectCmd({
  command: "erase",
  describe:
    "erase what Vector learned, its skills and workflow insights included, and a repository's Deep research (files you wrote are left alone; the app's model recommendations are erased from Settings > Memory)",
  builder: (yargs) =>
    scopeOption(yargs)
      .option("everywhere", { describe: "every repository and your own", type: "boolean", default: false })
      .option("yes", { describe: "confirm", type: "boolean", default: false }),
  handler: Effect.fn("Cli.memory.erase")(function* (args) {
    yield* CliOwnerGate.refuse("erase memory")
    const scope = args.everywhere ? "all" : args.personal ? "personal" : "repository"
    if (!args.yes) return yield* fail(eraseWarning(scope))
    const memory = yield* where
    const erased = yield* BrainErase.erase({
      brain: memory.brain,
      research: yield* ResearchStore.Service,
      place: memory.place,
      scope,
    })
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + erasedMessage(erased) + UI.Style.TEXT_NORMAL)
  }),
})

export const MemoryLearningCommand = effectCmd({
  command: "learning [state]",
  describe: "see or set whether Vector adds to its memory as it works",
  builder: (yargs) => yargs.positional("state", { choices: ["on", "off"] as const }),
  handler: Effect.fn("Cli.memory.learning")(function* (args) {
    if (args.state) yield* CliOwnerGate.refuse("turn learning on or off")
    const brain = yield* Brain.Service
    if (args.state) yield* brain.setLearning(args.state === "on")
    UI.println(`Learning is ${(yield* brain.learning()) ? "on" : "off"}.`)
  }),
})

// A readable page per kind, each entry with its evidence below it: open your brain and read it. Settings > Memory
// exports the same page (BrainExport).
export const MemoryExportCommand = effectCmd({
  command: "export",
  describe: "print memory as Markdown (or JSON): entries with their evidence, and what Vector read from documents",
  builder: (yargs) =>
    scopeOption(yargs)
      .option("repository", {
        describe: "only this repository's memory and documents",
        type: "boolean",
        default: false,
      })
      .option("json", {
        describe: "print JSON, which `vector memory import` reads back",
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.memory.export")(function* (args) {
    const memory = yield* where
    const knowledge = yield* BrainKnowledge.Service
    const text = yield* BrainExport.render({
      brain: memory.brain,
      knowledge,
      skills: yield* BrainSkill.Service,
      place: memory.place,
      scope: args.personal ? "personal" : args.repository ? "repository" : "all",
      format: args.json ? "json" : "markdown",
    })
    process.stdout.write(text.replaceAll("\n", EOL))
  }),
})

// An import never puts memory in use: every entry waits in Settings > Memory (or `vector memory approve`).
export const MemoryImportCommand = effectCmd({
  command: "import <file>",
  describe: "read an export back in; every entry waits for your approval",
  builder: (yargs) => yargs.positional("file", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.memory.import")(function* (args) {
    yield* CliOwnerGate.refuse("import memory")
    const file = Bun.file(path.resolve(args.file))
    if (!(yield* Effect.promise(() => file.exists()))) return yield* fail(`No file ${args.file}.`)
    if (file.size > BrainExport.LIMIT.text) return yield* fail("Vector imports at most 2 MB at a time.")
    const memory = yield* where
    const result = yield* BrainExport.importText({
      brain: memory.brain,
      skills: yield* BrainSkill.Service,
      place: memory.place,
      text: yield* Effect.promise(() => file.text()),
    })
    UI.println(
      UI.Style.TEXT_SUCCESS_BOLD +
        `Imported ${result.entries.length} entr${result.entries.length === 1 ? "y" : "ies"} to review` +
        UI.Style.TEXT_NORMAL,
    )
    for (const entry of result.entries) UI.println(line(entry))
    const left = [
      result.known ? `${result.known} already in memory` : undefined,
      result.refused ? `${result.refused} refused` : undefined,
      result.over ? `${result.over} past the ${BrainExport.LIMIT.entries} one import brings in` : undefined,
    ].filter((item): item is string => item !== undefined)
    if (left.length) UI.println(UI.Style.TEXT_DIM + `Left out: ${left.join(", ")}.` + UI.Style.TEXT_NORMAL)
    if (result.entries.length)
      UI.println(
        "Approve each with `vector memory approve <id>` (a skill with `vector memory skills approve <id>`), or in Settings > Memory.",
      )
  }),
})

// A learned skill lives outside memory, so memory does not find it: say where it is seen and changed.
const missing = Effect.fnUntraced(function* (id: string) {
  const memory = yield* where
  const skills = yield* BrainSkill.Service
  if (yield* skills.get(memory.place, id))
    return yield* fail(`${id} is a learned skill. See and change it with \`vector memory skills show ${id}\`.`)
  return yield* fail(`No memory ${id} here.`)
})

function line(entry: BrainSchema.Entry) {
  const marks = [
    entry.pinned ? "pinned" : undefined,
    entry.status === "active" ? undefined : entry.status,
    entry.hold ? `held: ${entry.hold}` : undefined,
    entry.stale ? "stale" : undefined,
    entry.scope === "personal" ? "personal" : undefined,
    entry.private ? "private" : undefined,
    entry.facet,
    entry.source ? path.basename(entry.source.file) : undefined,
  ].filter((mark): mark is string => mark !== undefined)
  return `${UI.Style.TEXT_HIGHLIGHT}${entry.id}${UI.Style.TEXT_NORMAL} ${entry.kind}: ${entry.text.replace(/\s+/g, " ").slice(0, 160)}${marks.length ? `${UI.Style.TEXT_DIM} (${marks.join(", ")})${UI.Style.TEXT_NORMAL}` : ""}`
}
