import type { Argv } from "yargs"
import { EOL } from "os"
import path from "path"
import { Effect, Fiber } from "effect"
import { BrainEmbed } from "@vectordevai/core/brain/embed"
import { BrainEmbedManifest } from "@vectordevai/core/brain/embed-manifest"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { BrainPaths } from "@vectordevai/core/brain/paths"
import type { BrainSchema } from "@vectordevai/core/brain/schema"
import { Flag } from "@vectordevai/core/flag/flag"
import { UntrustedGit } from "@vectordevai/core/untrusted-git"
import { Instruction } from "@/session/instruction"
import { SessionDistill } from "@/session/distill"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { CliOwnerGate } from "../owner-gate"
import { UI } from "../ui"

// `vector memory doc`: the documents Vector keeps for the repository in the current directory, as Settings > Memory >
// Documents shows them. Files are read on this computer; nothing here sends a document anywhere. Commands that add,
// change or settle what Vector knows are the owner's (CliOwnerGate); reading and searching stay open to the agent.

export const MemoryDocCommand = cmd({
  command: "doc",
  aliases: ["docs"],
  describe: "add documents for Vector to know, and see what it read from them",
  builder: (yargs: Argv) =>
    yargs
      .command(MemoryDocAddCommand)
      .command(MemoryDocExtractCommand)
      .command(MemoryDocListCommand)
      .command(MemoryDocShowCommand)
      .command(MemoryDocSearchCommand)
      .command(MemoryDocReadCommand)
      .command(MemoryDocForgetCommand)
      .command(MemoryDocReindexCommand)
      .command(MemoryDocApproveCommand)
      .command(MemoryDocRejectCommand)
      .command(MemoryDocDistillCommand)
      .demandCommand(),
  async handler() {},
})

/** The longest a command waits for a document to be read: past the reader's own 120 s limit for a PDF. */
const WAIT = 150_000

const where = Effect.gen(function* () {
  const instruction = yield* Instruction.Service
  return { knowledge: yield* BrainKnowledge.Service, place: yield* instruction.place() }
})

const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}${EOL}`)

export const MemoryDocAddCommand = effectCmd({
  command: "add [files..]",
  describe: "keep files as documents (- reads Markdown from stdin, for any converter's output)",
  builder: (yargs) =>
    yargs
      .positional("files", { describe: "files to keep, or - for Markdown on stdin", type: "string", array: true })
      .option("name", { describe: "the document's title", type: "string" })
      .option("replace", {
        describe: "read a file of the same name as a document here as its next version",
        type: "boolean",
        default: false,
      })
      .option("wait", {
        describe:
          "wait until the document is searchable by keywords, or also by meaning when the search model is in use",
        choices: ["keyword", "all"] as const,
        default: "keyword" as const,
      })
      .option("json", { describe: "print JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.memory.doc.add")(function* (args) {
    yield* CliOwnerGate.refuse("add documents")
    const memory = yield* where
    const files = [...(args.files ?? []).map(String), ...(stdinAsked() ? ["-"] : [])]
    if (files.length === 0) return yield* fail("Name a file to add, or - to read Markdown from stdin.")
    const titled = files.length === 1 ? args.name?.trim() : undefined
    const keep = Effect.fnUntraced(function* (file: string) {
      const piped = file === "-" ? yield* Effect.promise(() => Bun.stdin.text()) : undefined
      const input =
        piped === undefined
          ? { type: "path" as const, path: path.resolve(process.cwd(), file) }
          : {
              type: "text" as const,
              // Whatever the source was, what arrives on stdin is Markdown, kept under the name it was given.
              name: args.name?.trim() || "stdin",
              text: piped,
            }
      const result = yield* memory.knowledge.add(memory.place, {
        ...input,
        origin: "cli",
        replace: args.replace,
        ...(titled ? { title: titled } : {}),
      })
      if (result.type === "refused") return { file, result }
      // A file already kept under other bytes' name is renamed.
      if (titled && result.type === "unchanged")
        yield* memory.knowledge.update(memory.place, result.document.id, { title: titled })
      // All of it means searchable by meaning too, where the search model is downloaded and not paused.
      const document =
        (yield* memory.knowledge.wait(
          memory.place,
          result.document.id,
          args.wait === "all" ? "ready" : "searchable",
          args.wait === "all" ? 10 * WAIT : WAIT,
        )) ?? result.document
      return { file, result: { ...result, document: titled ? { ...document, title: titled } : document } }
    })
    const results: { file: string; result: BrainKnowledge.AddResult }[] = []
    for (const file of files) results.push(yield* keep(file))
    if (args.json) print(results.map((item) => ({ file: item.file, ...item.result })))
    if (!args.json)
      for (const item of results)
        UI.println(
          item.result.type === "refused"
            ? `${UI.Style.TEXT_DANGER_BOLD}${item.file}${UI.Style.TEXT_NORMAL}: ${refusal(item.result)}`
            : `${UI.Style.TEXT_SUCCESS_BOLD}${verb(item.result.type)}${UI.Style.TEXT_NORMAL} ${line(item.result.document)}`,
        )
    const refused = results.filter((item) => item.result.type === "refused").length
    if (refused > 0)
      return yield* fail(`${refused} of ${results.length} file${results.length === 1 ? " was" : "s were"} not added.`)
  }),
})

// A dry run: what Vector would learn, read the way `add` reads and stored nowhere.
export const MemoryDocExtractCommand = effectCmd({
  command: "extract <file>",
  describe: "show what Vector would learn from a file, storing nothing",
  builder: (yargs) =>
    yargs
      .positional("file", { type: "string", demandOption: true })
      .option("json", { describe: "print every section, passage and record as JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.memory.doc.extract")(function* (args) {
    const memory = yield* where
    const file = yield* Effect.promise(() =>
      BrainKnowledge.read(memory.place, { type: "path", path: path.resolve(process.cwd(), args.file), origin: "cli" }),
    )
    if (file.type === "refused") return yield* fail(file.message)
    const result = yield* memory.knowledge
      .extract({ name: file.name, bytes: file.bytes })
      .pipe(Effect.catch((error) => fail(`Vector could not read ${args.file}: ${error.message}`)))
    if ("type" in result) return yield* fail(result.message)
    if (args.json) return print(result)
    const kinds = Object.entries(
      result.records.reduce<Record<string, number>>(
        (all, record) => ({ ...all, [record.kind]: (all[record.kind] ?? 0) + 1 }),
        {},
      ),
    )
    UI.println(
      `${UI.Style.TEXT_HIGHLIGHT_BOLD}${result.title}${UI.Style.TEXT_NORMAL}: ${result.format}${result.pages ? `, ${result.pages} pages` : ""}, ${result.sections.length} sections, ${result.passages.length} passages, about ${result.tokens} tokens`,
    )
    UI.println(`Records: ${kinds.length ? kinds.map(([kind, count]) => `${count} ${kind}`).join(", ") : "none"}`)
    if (result.unread.length)
      UI.println(
        `${UI.Style.TEXT_WARNING}Pages with no text (scanned): ${result.unread.join(", ")}${UI.Style.TEXT_NORMAL}`,
      )
    if (result.warnings.length)
      UI.println(`${UI.Style.TEXT_WARNING}Warnings: ${result.warnings.join(", ")}${UI.Style.TEXT_NORMAL}`)
    if (result.hold)
      UI.println(`${UI.Style.TEXT_WARNING}It would wait for your review: ${result.hold}${UI.Style.TEXT_NORMAL}`)
    UI.empty()
    for (const record of result.records.slice(0, 40))
      UI.println(
        `  ${record.kind}${record.page ? ` p.${record.page}` : ""}: ${record.card}${record.hold ? ` (held: ${record.hold})` : ""}`,
      )
    if (result.records.length > 40) UI.println(`  … and ${result.records.length - 40} more; --json prints them all.`)
    UI.empty()
    UI.println(UI.Style.TEXT_DIM + "Nothing was stored. Run vector memory doc add to keep it." + UI.Style.TEXT_NORMAL)
  }),
})

export const MemoryDocListCommand = effectCmd({
  command: ["list", "ls"],
  describe: "list the documents Vector keeps for this repository",
  builder: (yargs) => yargs.option("json", { describe: "print JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.memory.doc.list")(function* (args) {
    const memory = yield* where
    const documents = yield* memory.knowledge.documents(memory.place, { personal: true })
    if (args.json) return print(documents)
    if (documents.length === 0) return UI.println("No documents yet. Add one with: vector memory doc add <file>")
    for (const document of documents) UI.println(line(document))
  }),
})

export const MemoryDocShowCommand = effectCmd({
  command: "show <id>",
  describe: "show a document: its outline and counts, its records, a page, its code links or what waits for review",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "the document's id or number", type: "string", demandOption: true })
      .option("records", { describe: "list its records", type: "boolean", default: false })
      .option("kind", {
        describe: "only records of this kind",
        choices: [
          "requirement",
          "constraint",
          "decision",
          "contract",
          "procedure",
          "term",
          "entity",
          "fact",
          "question",
        ] as const,
      })
      .option("page", { describe: "show the text Vector read from one page", type: "number" })
      .option("anchors", { describe: "list the code it is linked to", type: "boolean", default: false })
      .option("held", { describe: "list what waits for your review", type: "boolean", default: false })
      .option("json", { describe: "print JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.memory.doc.show")(function* (args) {
    const memory = yield* where
    const id = yield* resolve(args.id)
    const detail = yield* memory.knowledge.document(memory.place, id, { personal: true })
    if (!detail) return yield* fail(`No document ${args.id} here.`)
    if (args.page !== undefined) {
      const page = yield* memory.knowledge.page(memory.place, id, args.page, { personal: true })
      if (!page) return yield* fail(`Document ${args.id} has no page ${args.page}.`)
      if (args.json) return print(page)
      if (page.unread)
        UI.println(
          `${UI.Style.TEXT_WARNING}Page ${page.page} is a scanned image; Vector read no text on it.${UI.Style.TEXT_NORMAL}`,
        )
      for (const passage of page.passages) {
        UI.println(
          `${UI.Style.TEXT_DIM}[${passage.id}] ${passage.section}${passage.page !== undefined && passage.page < page.page ? ` (from p.${passage.page})` : ""}${passage.hold ? ` held: ${passage.hold}` : ""}${UI.Style.TEXT_NORMAL}`,
        )
        UI.println(passage.text)
        for (const record of passage.records)
          UI.println(
            `  ${UI.Style.TEXT_HIGHLIGHT}${record.id}${UI.Style.TEXT_NORMAL} ${record.kind}: ${passage.text.slice(record.start, record.end)}`,
          )
        UI.empty()
      }
      return
    }
    if (args.records || args.kind) {
      const records = yield* allRecords(id, args.kind)
      if (args.json) return print(records)
      if (records.length === 0) return UI.println("No records.")
      for (const record of records) UI.println(recordLine(record))
      return
    }
    if (args.anchors) {
      if (args.json) return print(detail.anchors)
      if (detail.anchors.length === 0) return UI.println("Not linked to any code yet.")
      for (const anchor of detail.anchors)
        UI.println(
          `${anchor.owner} → ${anchor.path}${anchor.symbol ? ` ${anchor.symbol}` : ""}${anchor.line ? `:${anchor.line}` : ""} (${anchor.status})`,
        )
      return
    }
    if (args.held) {
      if (args.json) return print(detail.held)
      if (detail.held.length === 0) return UI.println("Nothing in this document waits for your review.")
      for (const item of detail.held) UI.println(`${item.id}${item.page ? ` p.${item.page}` : ""}: held, ${item.hold}`)
      UI.println(UI.Style.TEXT_DIM + `Approve with: vector memory doc approve <id>` + UI.Style.TEXT_NORMAL)
      return
    }
    if (args.json) return print(detail)
    const document = detail.document
    UI.println(line(document))
    UI.println(
      `  ${document.stats.sections} sections, ${detail.counts.passages} passages, ${detail.counts.records} records (${detail.counts.active} in use, ${detail.counts.held} to review, ${detail.counts.archived} put away), about ${document.stats.tokens} tokens if sent whole`,
    )
    if (document.unread.length) UI.println(`  Pages with no text (scanned): ${document.unread.join(", ")}`)
    if (document.warnings.length) UI.println(`  Warnings: ${document.warnings.join(", ")}`)
    if (document.error) UI.println(`  ${UI.Style.TEXT_DANGER}${document.error}${UI.Style.TEXT_NORMAL}`)
    if (detail.versions.length > 1)
      UI.println(
        `  Versions: ${detail.versions.map((version) => `v${version.version} ${day(version.createdAt)} (${version.status})`).join(", ")}`,
      )
    UI.empty()
    for (const section of detail.sections.filter((item) => item.path))
      UI.println(
        `${"  ".repeat(Math.max(0, section.level - 1))}${section.heading}${section.pageStart === undefined ? "" : ` ${UI.Style.TEXT_DIM}p.${section.pageStart}${section.pageEnd && section.pageEnd !== section.pageStart ? `-${section.pageEnd}` : ""}${UI.Style.TEXT_NORMAL}`}`,
      )
  }),
})

export const MemoryDocSearchCommand = effectCmd({
  command: "search <query..>",
  describe: "search documents by keywords, and by meaning once the search model is downloaded, the way the agent does",
  builder: (yargs) =>
    yargs
      .positional("query", { type: "string", array: true, demandOption: true })
      .option("why", { describe: "say which of the words each result matched", type: "boolean", default: false })
      .option("json", { describe: "print JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.memory.doc.search")(function* (args) {
    const memory = yield* where
    const embed = yield* BrainEmbed.Service
    const query = args.query.join(" ")
    // A command runs once, so it loads the search model first rather than leave it for a next request.
    const meaning = yield* embed.prepare()
    const cards = yield* memory.knowledge.search(memory.place, { query, limit: 10, personal: true })
    const words = Array.from(new Set<string>(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []))
    // What each result shares with the query, said plainly; it is never sent to a model.
    const why = (card: BrainSchema.Card) =>
      words.filter((word) => `${card.title} ${card.section ?? ""} ${card.text}`.toLowerCase().includes(word))
    if (args.json) return print(cards.map((card) => (args.why ? { ...card, why: why(card) } : card)))
    if (cards.length === 0) return UI.println("Nothing in the documents matches.")
    for (const card of cards) {
      UI.println(
        `${UI.Style.TEXT_HIGHLIGHT}${card.id}${UI.Style.TEXT_NORMAL} ${card.kind} · ${card.title}${card.page ? ` p.${card.page}` : ""}${card.section ? ` §${card.section}` : ""}: ${card.text.replace(/\s+/g, " ").slice(0, 200)}`,
      )
      if (args.why)
        UI.println(
          `  ${UI.Style.TEXT_DIM}${why(card).length > 0 ? `matched: ${why(card).join(", ")}` : meaning ? "found by meaning" : "matched: related words"}${UI.Style.TEXT_NORMAL}`,
        )
    }
  }),
})

export const MemoryDocReadCommand = effectCmd({
  command: "read <id> [part]",
  describe: "read a document's outline, a section (3.2 or a heading) or a page (p14), or a record or passage",
  builder: (yargs) =>
    yargs
      .positional("id", {
        describe: "a document's id or number, or a record's or passage's id",
        type: "string",
        demandOption: true,
      })
      .positional("part", { describe: "a section number or heading, or a page such as p14", type: "string" }),
  handler: Effect.fn("Cli.memory.doc.read")(function* (args) {
    const memory = yield* where
    const id = /^#?\d+$/.test(args.id) ? yield* resolve(args.id) : args.id
    const got = yield* memory.knowledge.get(memory.place, {
      id,
      ...(args.part ? { part: args.part } : {}),
      // The user reads more than the agent is given at once.
      budget: 4 * BrainKnowledge.GET.part,
      personal: true,
    })
    if (!got) return yield* fail(args.part ? `Document ${args.id} has no ${args.part}.` : `Nothing ${args.id} here.`)
    process.stdout.write(`${got.text}${EOL}`)
  }),
})

export const MemoryDocForgetCommand = effectCmd({
  command: "forget <id>",
  describe: "forget a document and every version of it; Vector will not keep it again on its own",
  builder: (yargs) =>
    yargs.positional("id", { describe: "the document's id or number", type: "string", demandOption: true }),
  handler: Effect.fn("Cli.memory.doc.forget")(function* (args) {
    yield* CliOwnerGate.refuse("forget documents")
    const memory = yield* where
    const id = yield* resolve(args.id)
    if ((yield* memory.knowledge.remove(memory.place, id)) === "not-found")
      return yield* fail(`No document ${args.id} here.`)
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Forgot ${id}` + UI.Style.TEXT_NORMAL)
  }),
})

export const MemoryDocReindexCommand = effectCmd({
  command: "reindex [id]",
  describe: "read a document again from its file, or every document an older reader read",
  builder: (yargs) => yargs.positional("id", { describe: "the document's id or number", type: "string" }),
  handler: Effect.fn("Cli.memory.doc.reindex")(function* (args) {
    yield* CliOwnerGate.refuse("read documents again")
    const memory = yield* where
    const id = args.id ? yield* resolve(args.id) : undefined
    const count = yield* memory.knowledge.reindex(memory.place, id)
    if (id && count === 0)
      return yield* fail(
        `Vector cannot read ${args.id} again now: it is being read, or its file changed or is gone and no copy was kept.`,
      )
    const documents = yield* memory.knowledge.documents(memory.place, { personal: true })
    yield* Effect.forEach(
      documents.filter((document) => !id || document.id === id),
      (document) => memory.knowledge.wait(memory.place, document.id, "searchable", WAIT),
      { discard: true },
    )
    UI.println(`Read ${count} document${count === 1 ? "" : "s"} again.`)
  }),
})

const decide = (action: "approve" | "reject", describe: string, done: string) =>
  effectCmd({
    command: `${action} <id>`,
    describe,
    builder: (yargs) =>
      yargs
        .positional("id", {
          describe: "a document's id or number, or a held passage's or record's id",
          type: "string",
          demandOption: true,
        })
        .option("suggestions", {
          describe: "for approve: keep every record a model suggested for the document",
          type: "boolean",
          default: false,
          hidden: !Flag.VECTOR_KNOWLEDGE_DISTILL,
        }),
    handler: Effect.fn(`Cli.memory.doc.${action}`)(function* (args) {
      yield* CliOwnerGate.refuse(`${action} what waits for your review`)
      const memory = yield* where
      const id = /^#?\d+$/.test(args.id) ? yield* resolve(args.id) : args.id
      const change = args.suggestions && action === "approve" ? ("keep-suggestions" as const) : action
      if ((yield* memory.knowledge.update(memory.place, id, { action: change })) === "not-found")
        return yield* fail(`Nothing ${args.id} waits for your review here.`)
      UI.println(
        UI.Style.TEXT_SUCCESS_BOLD +
          `${change === "keep-suggestions" ? "Kept the suggestions for" : done} ${id}` +
          UI.Style.TEXT_NORMAL,
      )
    }),
  })

export const MemoryDocApproveCommand = decide(
  "approve",
  "let Vector use a document or passage that waited for your review",
  "Approved",
)
export const MemoryDocRejectCommand = decide(
  "reject",
  "forget a document, or put away a passage or record, that waited for your review",
  "Rejected",
)

// `vector memory doc distill <id>`: a model reads the sections the rules found little in, after the estimate, and what
// it suggests waits for review. Behind VECTOR_KNOWLEDGE_DISTILL, and hidden from help without it.
export const MemoryDocDistillCommand = effectCmd({
  command: "distill <id>",
  describe: Flag.VECTOR_KNOWLEDGE_DISTILL
    ? "ask a model to find more in a document; every suggestion quotes it and waits for your review"
    : false,
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "the document's id or number", type: "string", demandOption: true })
      .option("model", { describe: "provider/model to ask; the default model otherwise", type: "string" })
      .option("max-tokens", {
        describe: "the most section text to send, in tokens (1,000 to 30,000)",
        type: "number",
        default: 30_000,
      })
      .option("yes", { describe: "send it; without this only the estimate is shown", type: "boolean", default: false })
      .option("json", { describe: "print JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.memory.doc.distill")(function* (args) {
    yield* CliOwnerGate.refuse("ask a model to read documents")
    const memory = yield* where
    const distill = yield* SessionDistill.Service
    const input = {
      document: yield* resolve(args.id),
      ...(args.model ? { model: args.model } : {}),
      maxTokens: args.maxTokens,
    }
    if (!args.yes) {
      const estimate = yield* distill.estimate(memory.place, input)
      if (estimate.refused) return yield* fail(estimate.refused.message)
      if (args.json) return print(estimate.costKind === "codium" ? { ...estimate, billing: "codium" } : estimate)
      UI.println(
        estimate.costKind === "codium"
          ? `Runs on ${estimate.model} (Codium).`
          : estimate.input === undefined || estimate.output === undefined
            ? `Runs on ${estimate.model}. The usage estimate is unavailable.`
            : `Vector would send ${estimate.sections} section${estimate.sections === 1 ? "" : "s"} (about ${estimate.input.toLocaleString("en-US")} tokens) to ${estimate.model}, with up to ${estimate.output.toLocaleString("en-US")} tokens back.`,
      )
      if (estimate.costKind !== "codium") UI.println(costLine(estimate))
      UI.println(UI.Style.TEXT_DIM + "Nothing was sent. Run again with --yes to send it." + UI.Style.TEXT_NORMAL)
      return
    }
    const result = yield* distill.run(memory.place, input)
    if (result.type === "refused") return yield* fail(result.message)
    if (args.json) return print(result.costKind === "codium" ? { ...result, billing: "codium" } : result)
    const dropped = result.dropped.quote + result.dropped.scan + result.dropped.invalid
    UI.println(
      `${UI.Style.TEXT_SUCCESS_BOLD}${result.records.length} suggestion${result.records.length === 1 ? "" : "s"} from ${result.model}${UI.Style.TEXT_NORMAL}, waiting for your review.`,
    )
    if (dropped > 0)
      UI.println(
        `Dropped ${dropped}: ${result.dropped.quote} with a quote not in the document, ${result.dropped.scan} that failed a check, ${result.dropped.invalid} Vector could not read.`,
      )
    if (result.error) UI.println(`${UI.Style.TEXT_WARNING}${result.error}${UI.Style.TEXT_NORMAL}`)
    UI.println(
      UI.Style.TEXT_DIM +
        (result.costKind === "codium"
          ? "Spent: Codium"
          : result.tokens
            ? `Spent ${(result.tokens.input + result.tokens.output).toLocaleString("en-US")} tokens${result.costKind === "priced" && result.cost !== undefined ? `, $${result.cost.toFixed(4)} at catalog rates` : ""}.`
            : "Usage unavailable.") +
        UI.Style.TEXT_NORMAL,
    )
    if (result.records.length === 0) return
    UI.empty()
    for (const record of result.records) {
      UI.println(recordLine(record))
      UI.println(`  ${UI.Style.TEXT_DIM}“${record.quote}”${UI.Style.TEXT_NORMAL}`)
    }
    UI.empty()
    UI.println(
      UI.Style.TEXT_DIM +
        `Keep one with vector memory doc approve <id>, drop it with vector memory doc reject <id>, or keep them all with vector memory doc approve ${input.document} --suggestions.` +
        UI.Style.TEXT_NORMAL,
    )
  }),
})

// What a request may cost, in the CLI's words: catalog rates for a priced model.
function costLine(estimate: SessionDistill.Estimate) {
  if (estimate.costKind === "free") return "The model is free."
  if (estimate.costKind === "plan") return "Your plan covers the model."
  if (estimate.lowUsd === undefined || estimate.highUsd === undefined)
    return "The model has no listed price, so Vector cannot estimate what it costs."
  return `About $${estimate.lowUsd.toFixed(4)} to $${estimate.highUsd.toFixed(4)} at catalog rates.`
}

// `vector memory links <file>`: what documents say about a file, by the links Vector found to it in the code.
export const MemoryLinksCommand = effectCmd({
  command: "links <file>",
  describe: "show which documents and memory are linked to a file of this repository",
  builder: (yargs) =>
    yargs
      .positional("file", { describe: "a file of the repository", type: "string", demandOption: true })
      .option("relink", {
        describe: "link every document to the code again first, and say which names were too common to link",
        type: "boolean",
        default: false,
      })
      .option("json", { describe: "print JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.memory.links")(function* (args) {
    const memory = yield* where
    const linked = args.relink ? yield* memory.knowledge.link(memory.place) : undefined
    // The root comes from git in its full spelling, while the path given may spell a folder on the way another way:
    // through a link or a Windows junction, or by its Windows short name (RUNNER~1). Git places the file's folder in
    // its repository however it is spelled. The prefix is empty at the root, so the root is asked for too: it says
    // whether git answered at all, and that the folder is in this repository.
    const absolute = path.resolve(process.cwd(), args.file)
    const [top, prefix] = (yield* Effect.promise(() =>
      UntrustedGit.run(path.dirname(absolute), ["rev-parse", "--show-toplevel", "--show-prefix"]),
    )).split(/\r?\n/)
    const root = (folder: string) =>
      process.platform === "win32" ? path.resolve(folder).toLowerCase() : path.resolve(folder)
    const file =
      top && root(top) === root(memory.place.root)
        ? path.posix.join(prefix ?? "", path.basename(absolute))
        : BrainPaths.relative(memory.place.root, absolute)
    const links = yield* memory.knowledge.links(memory.place, file, { personal: true })
    if (args.json) return print(linked ? { links, linked } : links)
    if (linked)
      UI.println(
        `${UI.Style.TEXT_DIM}Linked again: ${linked.anchors} links, ${linked.pending} names waiting for their code${linked.common.length ? `; too common to link: ${linked.common.slice(0, 10).join(", ")}` : ""}.${UI.Style.TEXT_NORMAL}`,
      )
    if (links.length === 0) return UI.println(`Nothing Vector keeps is linked to ${file}.`)
    for (const link of links) {
      const anchor = link.anchor
      const how = anchor
        ? ` ${UI.Style.TEXT_DIM}(${anchor.method}${anchor.symbol ? ` ${anchor.symbol}` : ""}${anchor.line ? `:${anchor.line}` : ""}, ${anchor.status}${anchor.value ? `, code gives ${anchor.value.raw}` : ""})${UI.Style.TEXT_NORMAL}`
        : ""
      UI.println(
        `${UI.Style.TEXT_HIGHLIGHT}${link.owner}${UI.Style.TEXT_NORMAL} ${link.kind} · ${link.title}: ${link.text.replace(/\s+/g, " ").slice(0, 160)}${how}`,
      )
    }
  }),
})

// `vector memory review`: what needs the user's look, and their decision on each item.
export const MemoryReviewCommand = effectCmd({
  command: "review",
  describe: "list what needs your look: documents and memory that disagree, code that drifted, and held content",
  builder: (yargs) =>
    yargs
      .command(MemoryReviewResolveCommand)
      .option("json", { describe: "print JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.memory.review")(function* (args) {
    const memory = yield* where
    // The list is only useful with drift as the code is now.
    yield* memory.knowledge.drift(memory.place, { force: true })
    const items = yield* memory.knowledge.review(memory.place)
    if (args.json) return print(items)
    if (items.length === 0) return UI.println("Nothing needs a look.")
    for (const item of items) UI.println(reviewLine(item))
    UI.empty()
    UI.println(
      UI.Style.TEXT_DIM +
        "Settle one with: vector memory review resolve <id> <dismiss|keep-document|keep-code|keep|approve|reject> [winner]" +
        UI.Style.TEXT_NORMAL,
    )
  }),
})

export const MemoryReviewResolveCommand = effectCmd({
  command: "resolve <id> <action> [winner]",
  describe: "settle an item: dismiss it, keep the document or the code, keep one side of a conflict, approve or reject",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "the item's id, as review lists it", type: "string", demandOption: true })
      .positional("action", {
        choices: ["dismiss", "keep-document", "keep-code", "keep", "approve", "reject"] as const,
        demandOption: true,
      })
      .positional("winner", { describe: "for keep: the side of the conflict to keep", type: "string" })
      .option("json", { describe: "print JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.memory.review.resolve")(function* (args) {
    yield* CliOwnerGate.refuse("settle what needs your look")
    const memory = yield* where
    if (args.action === "keep" && !args.winner)
      return yield* fail("Name the side to keep: vector memory review resolve <id> keep <winner>")
    const result = yield* memory.knowledge.resolve(memory.place, args.id, {
      action: args.action,
      ...(args.winner ? { winner: args.winner } : {}),
    })
    if (!result) return yield* fail(`Nothing needs a look as ${args.id}, or not that way.`)
    if (result.type === "refused") return yield* fail(result.message)
    if (args.json) return print(result)
    if (result.type === "settled")
      return UI.println(`${args.action === "approve" ? "Approved" : "Rejected"} ${args.id}.`)
    UI.println(`${result.item.status === "dismissed" ? "Dismissed" : "Settled"} ${args.id}.`)
    if (result.entry) UI.println(`Saved as a decision: [${result.entry.id}] ${result.entry.text}`)
  }),
})

// `vector memory repo-docs on|off`: whether Vector reads the repository's own docs (READMEs, docs/, ADRs, API specs).
export const MemoryRepoDocsCommand = effectCmd({
  command: "repo-docs [state]",
  describe: "see or set whether Vector reads this repository's own docs, which are shared like its memory, not private",
  builder: (yargs) => yargs.positional("state", { choices: ["on", "off"] as const }),
  handler: Effect.fn("Cli.memory.repoDocs")(function* (args) {
    if (args.state) yield* CliOwnerGate.refuse("change whether Vector reads this repository's docs")
    const memory = yield* where
    const settings = args.state
      ? yield* memory.knowledge.configure(memory.place, { repositoryDocs: args.state === "on" })
      : yield* memory.knowledge.settings(memory.place)
    UI.println(
      settings.repositoryDocs
        ? "Vector reads this repository's docs (READMEs, docs/, decision records and API specs). Unlike documents you add, they are not private: they are shared like the repository's memory, with invited guests and with models that may train on prompts."
        : "Vector does not read this repository's docs.",
    )
  }),
})

// `vector memory model`: the local model documents are searched by meaning with. Downloaded once when asked, then run
// on this computer with no network; until then search uses keywords and code links.
export const MemoryModelCommand = cmd({
  command: "model",
  describe: "the local model Vector searches documents by meaning with: see it, download it once, or remove it",
  builder: (yargs: Argv) =>
    yargs
      .command(MemoryModelStatusCommand)
      .command(MemoryModelDownloadCommand)
      .command(MemoryModelInstallCommand)
      .command(MemoryModelRemoveCommand)
      .command(MemoryModelPauseCommand)
      .command(MemoryModelResumeCommand)
      .demandCommand(),
  async handler() {},
})

const choice = (args: { codeAware?: boolean; fullPrecision?: boolean }) => ({
  model: args.codeAware ? ("granite-small-r2-q8" as const) : BrainEmbedManifest.DEFAULT,
  variant: args.fullPrecision ? ("fp32" as const) : ("int8" as const),
})

const modelOptions = (yargs: Argv) =>
  yargs
    .option("code-aware", {
      describe: "the larger Code-aware preview model (55 MB) instead of the default",
      type: "boolean",
      default: false,
    })
    .option("full-precision", {
      describe: "the full-precision graph (90 MB, not yet verified), for a computer where the int8 one fails its check",
      type: "boolean",
      default: false,
    })

export const MemoryModelStatusCommand = effectCmd({
  command: "status",
  describe: "whether the search model is downloaded and how much of this repository's documents it has embedded",
  builder: (yargs) => yargs.option("json", { describe: "print JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.memory.model.status")(function* (args) {
    const memory = yield* where
    const status = yield* memory.knowledge.model(memory.place)
    if (args.json) return print(status)
    for (const line of modelLines(status)) UI.println(line)
  }),
})

export const MemoryModelDownloadCommand = effectCmd({
  command: "download",
  describe: "download the search model once; documents are then searched by meaning on this computer",
  builder: (yargs) =>
    modelOptions(yargs)
      .option("yes", { describe: "download without asking first", type: "boolean", default: false })
      .option("json", { describe: "print JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.memory.model.download")(function* (args) {
    yield* CliOwnerGate.refuse("change the search model")
    const memory = yield* where
    const embed = yield* BrainEmbed.Service
    const picked = choice(args)
    const model = BrainEmbedManifest.MODELS[picked.model]
    const bytes = BrainEmbedManifest.size(model, picked.variant)
    if (!args.json) {
      UI.println(
        `${UI.Style.TEXT_HIGHLIGHT_BOLD}${model.label}${UI.Style.TEXT_NORMAL}: a one-time ${BrainEmbedManifest.megabytes(bytes)} download, then it runs on this computer with no network.`,
      )
      UI.println(`${model.description}`)
      UI.println(
        `${model.owner}, ${model.license}. Source: https://huggingface.co/${model.repo}/tree/${model.revision}`,
      )
      if (model.preview) UI.println(`${UI.Style.TEXT_WARNING}${model.preview}${UI.Style.TEXT_NORMAL}`)
      if (picked.variant === "fp32")
        UI.println(
          `${UI.Style.TEXT_WARNING}Not yet verified: the full-precision graph has not been run in this release, so it may not pass its check here either.${UI.Style.TEXT_NORMAL}`,
        )
    }
    if (!args.yes) {
      if (!process.stdin.isTTY) return yield* fail("Run again with --yes to download it.")
      const { confirm, isCancel } = yield* Effect.promise(() => import("@clack/prompts"))
      const answer = yield* Effect.promise(() => confirm({ message: "Download it now?" }))
      if (isCancel(answer) || !answer) return UI.println("Nothing was downloaded.")
    }
    // Progress on one line while it runs, for a terminal.
    const progress = yield* Effect.gen(function* () {
      for (;;) {
        yield* Effect.sleep("500 millis")
        const status = yield* embed.status()
        if (process.stderr.isTTY && !args.json && status.state === "downloading")
          process.stderr.write(
            `\r${Math.round((status.progress ?? 0) * 100)}% of ${BrainEmbedManifest.megabytes(status.total ?? bytes)}`,
          )
      }
    }).pipe(Effect.forkChild)
    const result = yield* embed.download(picked).pipe(
      Effect.ensuring(Fiber.interrupt(progress)),
      Effect.catch((error) => fail(error.message)),
    )
    if (process.stderr.isTTY && !args.json) process.stderr.write("\r")
    const status = yield* memory.knowledge.model(memory.place)
    if (args.json) return print(status)
    for (const line of modelLines(status)) UI.println(line)
    if (result.state !== "ready") return yield* fail("The search model is downloaded but cannot be used here.")
  }),
})

export const MemoryModelInstallCommand = effectCmd({
  command: "install",
  describe: "install the search model from a folder of its pinned files, for a computer with no network",
  builder: (yargs) =>
    modelOptions(yargs)
      .option("from", { describe: "the folder that holds the model's files", type: "string", demandOption: true })
      .option("json", { describe: "print JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.memory.model.install")(function* (args) {
    yield* CliOwnerGate.refuse("change the search model")
    const memory = yield* where
    const embed = yield* BrainEmbed.Service
    yield* embed
      .install(path.resolve(process.cwd(), args.from), choice(args))
      .pipe(Effect.catch((error) => fail(error.message)))
    const status = yield* memory.knowledge.model(memory.place)
    if (args.json) return print(status)
    for (const line of modelLines(status)) UI.println(line)
    if (status.state !== "ready") return yield* fail("The search model is installed but cannot be used here.")
  }),
})

export const MemoryModelRemoveCommand = effectCmd({
  command: "remove",
  describe: "delete the downloaded search model and the vectors made with it",
  handler: Effect.fn("Cli.memory.model.remove")(function* () {
    yield* CliOwnerGate.refuse("change the search model")
    const knowledge = yield* BrainKnowledge.Service
    yield* knowledge.removeModel()
    UI.println("Removed. Vector searches documents by keywords and code links until you download the model again.")
  }),
})

export const MemoryModelPauseCommand = effectCmd({
  command: "pause",
  describe: "hold embedding documents in the background, until you resume it",
  handler: Effect.fn("Cli.memory.model.pause")(function* () {
    yield* CliOwnerGate.refuse("change the search model")
    const embed = yield* BrainEmbed.Service
    yield* embed.pause(true)
    UI.println(
      "Paused. What is embedded is still searched by meaning; the rest waits until `vector memory model resume`.",
    )
  }),
})

export const MemoryModelResumeCommand = effectCmd({
  command: "resume",
  describe: "go on embedding documents in the background",
  handler: Effect.fn("Cli.memory.model.resume")(function* () {
    yield* CliOwnerGate.refuse("change the search model")
    const embed = yield* BrainEmbed.Service
    yield* embed.pause(false)
    UI.println("Resumed.")
  }),
})

// The search model's state in a few lines, as Settings > Memory > Search model says it.
function modelLines(status: BrainSchema.ModelStatus) {
  const option = status.options?.find((item) => item.id === status.model)
  const name = option?.label ?? "Search by meaning"
  const embedded = status.embedded
  const progress =
    embedded && embedded.total > 0
      ? [
          `Embedded: ${embedded.done.toLocaleString("en-US")} of ${embedded.total.toLocaleString("en-US")} passages and records in this repository${status.paused ? " (paused)" : ""}.`,
        ]
      : []
  if (status.state === "absent")
    return [
      "Search by meaning is not downloaded: Vector searches documents by keywords and code links.",
      ...(status.downloads === false
        ? ["Downloads are turned off here. Install the model with `vector memory model install --from <folder>`."]
        : [
            `Download the ${BrainEmbedManifest.megabytes(status.options?.[0]?.bytes ?? 0)} model once with \`vector memory model download\`.`,
          ]),
      ...(status.error ? [`Last attempt: ${status.error}`] : []),
    ]
  if (status.state === "downloading" || status.state === "verifying")
    return [`${name}: ${status.state} (${Math.round((status.progress ?? 0) * 100)}%).`]
  if (status.state === "failed")
    return [
      `${name} cannot be used on this computer: ${status.error ?? "it failed its check"}`,
      ...(status.fallback
        ? [
            "Download the full-precision graph instead with `vector memory model download --full-precision`. It is not yet verified, so it may not pass its check here either.",
          ]
        : []),
      "Until then Vector searches documents by keywords and code links.",
    ]
  return [
    `${name}: ready (${status.variant ?? "int8"}, ${BrainEmbedManifest.megabytes(status.total ?? 0)}${status.source === "mirror" ? ", from Vector's copy" : status.source === "folder" ? ", installed from a folder" : ""}).`,
    ...progress,
    ...(option ? [`${option.owner}, ${option.license}. Source: ${option.source}`, `sha256 ${option.sha256}`] : []),
    ...(status.check
      ? [
          status.check.by === "vectors"
            ? `Checked on this computer: lowest match ${status.check.lowest.toFixed(3)} (needs ${status.check.needed}).`
            : "Checked on this computer by how it ranks its test sentences.",
        ]
      : []),
    ...(status.worker?.mode === "in-process"
      ? [`It does not run here: ${status.worker.reason ?? "Vector's background reader is not running"}.`]
      : []),
  ]
}

// Whether `-` (stdin) is among the files. yargs drops a lone "-" from a list of positionals, so it is looked for where
// the user typed it, after `doc add`.
function stdinAsked() {
  const raw = process.argv.slice(2)
  const at = raw.findIndex((arg, index) => arg === "add" && (raw[index - 1] === "doc" || raw[index - 1] === "docs"))
  if (at < 0) return false
  const rest = raw.slice(at + 1)
  const end = rest.indexOf("--")
  return (end < 0 ? rest : rest.slice(0, end)).some((arg, index, all) => arg === "-" && all[index - 1] !== "--name")
}

// A document by its id, or by the number it is listed under.
const resolve = Effect.fnUntraced(function* (input: string) {
  if (!/^#?\d+$/.test(input)) return input
  const memory = yield* where
  const ordinal = Number(input.replace("#", ""))
  const found = (yield* memory.knowledge.documents(memory.place, { personal: true })).find(
    (document) => document.ordinal === ordinal,
  )
  return found?.id ?? input
})

const allRecords = Effect.fnUntraced(function* (document: string, kind?: BrainSchema.RecordKind) {
  const memory = yield* where
  const pages: BrainSchema.Record[] = []
  for (let cursor: string | undefined = undefined; ; ) {
    const page: BrainKnowledge.RecordPage = yield* memory.knowledge.records(memory.place, {
      document,
      ...(kind ? { kind } : {}),
      status: "all",
      limit: BrainKnowledge.LIMIT.records,
      ...(cursor ? { cursor } : {}),
      personal: true,
    })
    pages.push(...page.records)
    if (!page.cursor) return pages
    cursor = page.cursor
  }
})

// Why a file was not added, in the CLI's words: a new version is the user's call, made with --replace.
function refusal(result: {
  readonly reason: string
  readonly message: string
  readonly document?: BrainSchema.Document
}) {
  if (result.reason !== "version" || !result.document) return result.message
  return `${result.document.name} is already document #${result.document.ordinal} (v${result.document.version}, added ${day(result.document.createdAt)}). Run again with --replace to read this file as its next version.`
}

function verb(type: "queued" | "unchanged" | "version") {
  if (type === "unchanged") return "Already kept"
  if (type === "version") return "Replaced with a new version:"
  return "Added"
}

function day(at: number) {
  return new Date(at).toISOString().slice(0, 10)
}

function line(document: BrainSchema.Document) {
  const marks = [
    document.status === "held" && document.hold ? `held: ${document.hold}` : document.status,
    document.paused ? "paused" : undefined,
    document.visibility === "private" ? "private" : undefined,
    document.version > 1 ? `v${document.version}` : undefined,
  ].filter((mark): mark is string => mark !== undefined)
  return `${UI.Style.TEXT_HIGHLIGHT}#${document.ordinal} ${document.id}${UI.Style.TEXT_NORMAL} ${document.title} ${UI.Style.TEXT_DIM}(${document.format}${document.pages ? `, ${document.pages} pages` : ""}, ${document.stats.records} records; ${marks.join(", ")})${UI.Style.TEXT_NORMAL}`
}

function reviewLine(item: BrainSchema.ReviewItem) {
  const detail = item.detail
  const text = (value: unknown) => (typeof value === "string" ? value : "")
  const side = (value: unknown) =>
    value && typeof value === "object" && "id" in value && "text" in value
      ? `[${text(value.id)}] ${text(value.text)}`
      : ""
  const head = `${UI.Style.TEXT_HIGHLIGHT}${item.id}${UI.Style.TEXT_NORMAL} ${item.kind}`
  if (item.kind === "drift" && detail.type === "value")
    return `${head}: [${item.a}] says ${text(detail.document)}; the code says ${text(detail.code)} (${text(detail.path)}:${String(detail.line ?? "")})`
  if (item.kind === "drift")
    return `${head}: [${item.a}] is linked to ${text(detail.path)}${detail.line ? `:${String(detail.line)}` : ""}${detail.symbol ? ` ${text(detail.symbol)}` : ""}, which ${detail.type === "missing" ? "is gone" : "changed"}`
  if (item.kind === "conflict")
    return `${head} (${text(detail.type)}): ${side(detail.a)} against ${side(detail.b)}${detail.prefer ? ` ${UI.Style.TEXT_DIM}(Vector would keep [${text(detail.prefer)}])${UI.Style.TEXT_NORMAL}` : ""}`
  return `${head}: ${text(detail.type)} of ${text(detail.title)}, held: ${text(detail.hold)}${detail.text ? ` ${UI.Style.TEXT_DIM}${text(detail.text).slice(0, 120)}${UI.Style.TEXT_NORMAL}` : ""}`
}

function recordLine(record: BrainSchema.Record) {
  const marks = [
    record.status === "active" ? undefined : record.hold ? `${record.status}: ${record.hold}` : record.status,
    record.pinned ? "pinned" : undefined,
    record.userEdited ? "edited" : undefined,
    record.page ? `p.${record.page}` : undefined,
  ].filter((mark): mark is string => mark !== undefined)
  return `${UI.Style.TEXT_HIGHLIGHT}${record.id}${UI.Style.TEXT_NORMAL} ${record.kind}: ${record.card.replace(/\s+/g, " ").slice(0, 200)}${marks.length ? `${UI.Style.TEXT_DIM} (${marks.join(", ")})${UI.Style.TEXT_NORMAL}` : ""}`
}
