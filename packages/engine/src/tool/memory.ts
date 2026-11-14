import { createHash } from "node:crypto"
import path from "path"
import { Effect, Schema } from "effect"
import { fileURLToPath } from "url"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { BrainSchema } from "@vectordevai/core/brain/schema"
import { BrainSkill } from "@vectordevai/core/brain/skill"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { ResearchStore } from "@vectordevai/core/research/store"
import { FSUtil } from "@vectordevai/core/fs-util"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import { SessionID } from "@vectordevai/schema/session-id"
import { Git } from "@/git"
import { Session } from "@/session/session"
import { Instruction } from "../session/instruction"
import { SessionMemory } from "../session/memory"
import * as Tool from "./tool"
import DESCRIPTION from "./memory.txt"
import DOCUMENTS from "./memory-documents.txt"

/** The line the definition gains while the repository has documents a request may draw on. */
export { DOCUMENTS }

// Every Work request carries this definition, so it stays small: a search reads `text`, and an entry about a file takes
// the cited file as its path scope instead of a parameter of its own.
export const Parameters = Schema.Struct({
  action: Schema.Literals(["search", "get", "add", "update", "forget", "keep"]),
  id: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  kind: Schema.optional(BrainSchema.LearnedKind),
  scope: Schema.optional(BrainSchema.Scope),
  quote: Schema.optional(Schema.String),
  file: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
})

type Metadata = {
  action: string
  result?: string
  id?: string
  hold?: BrainSchema.Hold
  /**
   * What the agent just put in use on its own, for the session's "Learned: … · Undo" line. The words are there only for
   * a repository entry; a personal entry's stay out of the transcript.
   */
  learned?: { scope: BrainSchema.Scope; text?: string; private?: boolean; document?: boolean }
  /** Personal entries this result stands in for; the transcript keeps their ids, never their words. */
  [SessionMemory.PERSONAL]?: string[]
  /** Document cards and passages this result stands for, rendered again for every request. */
  [SessionMemory.KNOWLEDGE]?: {
    cards?: string[]
    get?: { id: string; part?: string; budget: number }[]
    tokens?: number
    document?: string
  }
}

export const MemoryTool = Tool.define<
  typeof Parameters,
  Metadata,
  Brain.Service | BrainKnowledge.Service | Instruction.Service | FreeModelGuests.Service | Git.Service | Session.Service | ResearchStore.Service
>(
  "memory",
  Effect.gen(function* () {
    const brain = yield* Brain.Service
    const knowledge = yield* BrainKnowledge.Service
    const instruction = yield* Instruction.Service
    const guests = yield* FreeModelGuests.Service
    const git = yield* Git.Service
    const sessions = yield* Session.Service
    const research = yield* ResearchStore.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const place = yield* instruction.place()
          const guest = yield* guests.marked(SessionID.make(ctx.sessionID))
          // The owner's personal memory is not for a session an invited guest drives, nor for a model that may train on
          // prompts, nor for a role whose output leaves the machine or reaches the web (section 6.4a). The session
          // runtime says which the model is; without its word, personal memory stays out.
          const personal = !guest && ctx.extra?.mayTrain === false && ctx.extra?.outward !== true

          // keep: the user asked to save research. The report came from web pages, so the user says yes every time
          // (PermissionPolicy.RESEARCH_KEEP); without an id it is this session's latest run.
          if (params.action === "keep") {
            const runs = (yield* research.list(place)).map((summary) => summary.run)
            const run = params.id
              ? runs.find((item) => item.id === params.id)
              : runs.find((item) => item.session_id === ctx.sessionID)
            if (!run) return refused("keep", params.id ? `No research run ${params.id} here.` : "This session has no research run to keep.")
            if (run.kept)
              return { title: "Research already kept", output: `"${run.question}" is already kept in this repository's brain.`, metadata: { action: "keep", id: run.id } }
            if (guest) return refused("keep", ResearchStore.GUEST)
            yield* ctx.ask({
              permission: PermissionPolicy.RESEARCH_KEEP,
              patterns: [run.id],
              always: [],
              metadata: { runID: run.id, question: run.question },
            })
            const kept = yield* research.keep(place, run.id)
            if (!kept) return refused("keep", `No research run ${run.id} here.`)
            if (kept.type === "refused") return refused("keep", kept.message)
            return {
              title: "Kept research",
              output: `Kept "${run.question}" in this repository's brain. Later requests can recall its report.`,
              metadata: { action: "keep", id: run.id },
            }
          }

          if (params.action === "search") {
            const found = yield* brain.search(place, {
              query: params.text ?? "",
              personal,
              sessionID: ctx.sessionID,
            })
            const cards = params.text
              ? yield* knowledge.search(place, { query: params.text, personal, sessionID: ctx.sessionID })
              : []
            // Personal entries and document cards are saved as ids; each request fills their lines in where allowed.
            return {
              title: params.text ? `Memory: ${params.text}` : "Memory",
              output:
                found.length || cards.length
                  ? [
                      ...found.map((entry) => (kept(entry) ? SessionMemory.withheld(entry.id) : describe(entry))),
                      ...cards.map((card) => SessionMemory.document(card.id)),
                    ].join("\n")
                  : "Nothing in memory matches. Search with other words, or carry on without it.",
              metadata: {
                action: "search",
                result: `${found.length + cards.length}`,
                ...withheld(found),
                ...(cards.length ? { [SessionMemory.KNOWLEDGE]: { cards: cards.map((card) => card.id) } } : {}),
              },
            }
          }

          // A record, passage or document: its text is rendered for each request, never kept in the transcript.
          if (params.action === "get" && params.id && DOCUMENT_ID.test(params.id)) {
            const tier = (ctx.extra?.taskSize as { tier?: BrainKnowledge.Tier } | undefined)?.tier ?? "standard"
            const since = SessionMemory.since(ctx.messages)
            const read = ctx.messages
              .filter((message) => message.info.time.created >= since)
              .flatMap((message) => message.parts)
              .reduce((sum, part) => sum + (SessionMemory.knowledge(part)?.tokens ?? 0), 0)
            const budget = BrainKnowledge.READS[tier] - read
            if (budget <= 0) return refused("get", "The document budget for this request is used.")
            const got = yield* knowledge.get(place, {
              id: params.id,
              ...(params.text ? { part: params.text } : {}),
              budget,
              personal,
              sessionID: ctx.sessionID,
              requestID: ctx.messageID,
            })
            if (!got)
              return refused(
                "get",
                `No document card, passage or page ${params.id}${params.text ? ` ${params.text}` : ""} here.`,
              )
            if (got.type !== "text")
              return { title: `Memory ${got.id}`, output: got.text, metadata: { action: "get", id: got.id } }
            return {
              title: `Memory ${got.id}`,
              output: SessionMemory.document(got.id),
              metadata: {
                action: "get",
                id: got.id,
                [SessionMemory.KNOWLEDGE]: {
                  get: [{ id: params.id, ...(params.text ? { part: params.text } : {}), budget }],
                  tokens: got.tokens,
                },
              },
            }
          }

          if (params.action === "get") {
            const detail = params.id ? yield* brain.get(place, params.id, { personal }) : undefined
            if (!detail) return refused("get", `No memory ${params.id ?? ""} here.`)
            // A personal entry's evidence is the user's own words, and a private one's came from a private document, so
            // either shows as its line alone.
            if (kept(detail.entry))
              return {
                title: `Memory ${detail.entry.id}`,
                output: SessionMemory.withheld(detail.entry.id),
                metadata: { action: "get", id: detail.entry.id, ...withheld([detail.entry]) },
              }
            return {
              title: `Memory ${detail.entry.id}`,
              output: [
                describe(detail.entry),
                ...detail.evidence.slice(-3).map((item) => `  evidence: ${evidenceLine(item)}`),
                ...(detail.related.length
                  ? [
                      `Related: ${detail.related.map((item) => (kept(item) ? `[${item.id}] (personal)` : `[${item.id}] ${item.text.slice(0, 60)}`)).join("; ")}`,
                    ]
                  : []),
              ].join("\n"),
              metadata: { action: "get", id: detail.entry.id },
            }
          }

          // A learned skill is changed only in Settings > Memory > Skills, never by the agent.
          if (params.id && (params.action === "forget" || params.action === "update") && BrainSkill.ID.test(params.id))
            return refused(params.action, SKILL_ENTRY)

          // Writes: what the session took in decides whether they wait for the user. Once a session is compacted the
          // agent gets a summary instead of the messages before it, but the summary carries whatever they brought in,
          // so the whole session counts.
          const history = yield* sessions
            .messages({ sessionID: SessionID.make(ctx.sessionID) })
            .pipe(Effect.catch(() => Effect.succeed([])))
          // Vector keeps what it learns from the documents it was given, as private as they are. What it read from a
          // document that came from outside (kept while a session read the web, an MCP server or a subagent, in a
          // guest's session or from an untrusted repository) is outside content like any other.
          const read = yield* knowledge.sources(place, SessionMemory.documents([...history, ...ctx.messages]))
          // A quote from a document's card or passage is evidence only in that passage's own words. What is learned
          // from it is as private as its document, and waits for the user when the document came from outside.
          const quoted =
            params.action !== "forget" && params.text && params.file && params.quote && QUOTABLE.test(params.file)
              ? yield* knowledge.quoted(place, { id: params.file, quote: params.quote, personal })
              : undefined
          if (quoted?.type === "refused") return refused(params.action, quoted.message)
          // A document forgotten since it was read was the user's to keep private too.
          const decided = SessionMemory.writeHold({
            guest,
            agent: SessionMemory.agentStarted(),
            held: place.held,
            messages: [...history, ...ctx.messages],
            sources: [...read.documents, ...(quoted ? [quoted.document] : [])],
            missing: read.missing.length,
          })
          const hold = decided.hold
          const privately = decided.private

          // An entry the agent may not see here is one it may not change either.
          const target =
            params.id && params.action !== "add" ? yield* brain.get(place, params.id, { personal }) : undefined
          if (params.id && params.action !== "add" && !target)
            return refused(params.action, `No memory ${params.id} here.`)
          // The agent changes only what is in use. What was put away, replaced or waits for review is the user's to
          // bring back or decide on, so neither an update nor a forget may touch it.
          const unused = target ? inactive(target.entry) : undefined
          if (unused) return refused(params.action, unused)

          if (params.action === "forget") {
            if (!params.id) return refused("forget", "Say which memory to forget, by id.")
            // The agent only puts an entry away; the user deletes for good in Settings > Memory. A session that read
            // outside content may not put anything away at all, so planted text cannot wipe what Vector knows, and
            // what the user wrote (or a file says) is theirs to put away.
            if (hold)
              return refused(
                "forget",
                "This session took in outside content, so ask the user to forget it in Settings > Memory.",
              )
            if (target?.entry.origin !== "agent")
              return refused(
                "forget",
                `${params.id} is the user's own, so ask them to put it away in Settings > Memory.`,
              )
            const result = yield* brain.update(place, params.id, { action: "archive" }, "agent")
            if (!result || result.type === "refused")
              return refused("forget", result?.type === "refused" ? result.message : `No memory ${params.id} here.`)
            return {
              title: `Put away ${params.id}`,
              output: `Put away ${params.id}. The user can restore it in Settings > Memory.`,
              metadata: { action: "forget", id: params.id },
            }
          }

          // A file kept as a document: one in this working tree or attached to this conversation, or "message", the long
          // text the user pasted in this request. It is in use at once unless the session took in outside content, and
          // the user can forget it in Settings > Memory.
          if (params.action === "add" && !params.text && params.file) {
            if (guest) return refused("add", "A session an invited guest is in cannot keep documents.")
            const since = SessionMemory.since(ctx.messages)
            const kept = ctx.messages
              .filter((message) => message.info.time.created >= since)
              .flatMap((message) => message.parts)
              .filter((part) => SessionMemory.knowledge(part)?.document !== undefined).length
            if ((yield* brain.written(ctx.sessionID, since)) + kept >= Brain.LIMIT.perMessage)
              return refused("add", "That is enough memory writes for one request; keep the rest in a later one.")
            const file = keepable(params.file, place.root, ctx.messages)
            if (typeof file === "string") return refused("add", file)
            const result = yield* knowledge.add(place, {
              ...file,
              origin: "agent",
              sessionID: ctx.sessionID,
              ...(hold ? { hold } : {}),
            })
            if (result.type === "refused") return refused("add", result.message)
            const document =
              result.type === "unchanged"
                ? result.document
                : ((yield* knowledge.wait(place, result.document.id, "searchable", 10_000)) ?? result.document)
            // Kept on the agent's word and in use: the session shows it with Undo, which forgets it. A private
            // document's title stays out of the transcript.
            const learned = result.type !== "unchanged" && document.status !== "held" && document.status !== "failed"
            return {
              title: `Kept ${document.title}`,
              output: keptLine(document, result.type),
              metadata: {
                action: "add",
                result: result.type,
                id: document.id,
                ...(document.hold ? { hold: document.hold } : {}),
                ...(learned
                  ? {
                      learned: {
                        scope: "repository" as const,
                        document: true,
                        ...(document.visibility === "private" ? { private: true } : { text: document.title }),
                      },
                    }
                  : {}),
                [SessionMemory.KNOWLEDGE]: { document: document.id },
              },
            }
          }

          if (!params.text) return refused(params.action, "Give the text to remember.")
          if (params.action === "update" && !params.id) return refused("update", "Say which memory to update, by id.")
          if (params.file && SECRET_FILE.test(params.file.replace(/\\/g, "/")))
            return refused(
              params.action,
              "Vector does not cite .env, key or credentials files as evidence. Quote the user, or cite another file.",
            )
          const evidence =
            quoted && params.file && params.quote
              ? {
                  type: "document" as const,
                  path: params.file.replace(/^\[|\]$/g, ""),
                  quote: params.quote,
                  verified: true,
                }
              : yield* verify(params, ctx, place.root, git)
          const result = yield* brain.propose(place, {
            kind: params.kind ?? "lesson",
            text: params.text,
            scope: params.scope ?? "repository",
            // An entry about a file comes up again when that file is read, so its cited file in this working tree is
            // its path scope, checked or not.
            ...(evidence?.type === "file" && FSUtil.contains(place.root, path.resolve(place.root, evidence.path))
              ? { paths: [evidence.path] }
              : {}),
            ...(evidence ? { evidence } : {}),
            ...(params.action === "update" ? { supersedes: params.id } : {}),
            origin: "agent",
            sessionID: ctx.sessionID,
            since: SessionMemory.since(ctx.messages),
            ...(hold ? { hold } : {}),
            ...(privately ? { private: true } : {}),
          })
          if (result.type === "refused") return refused(params.action, result.message)
          // Derived from the card it quotes, and related to what else it bears on.
          if (evidence?.type === "document")
            yield* knowledge.derive(place, { entry: result.entry, from: evidence.path })
          // A write that put words in use, rather than finding them there or holding them, is something learned.
          const learned = result.type === "added" || result.type === "superseded" || result.type === "promoted"
          return {
            title: `Memory ${result.type}: ${result.entry.id}`,
            output: written(result, target?.entry),
            metadata: {
              action: params.action,
              result: result.type,
              id: result.entry.id,
              ...(result.entry.hold ? { hold: result.entry.hold } : {}),
              ...(learned
                ? {
                    learned: {
                      scope: result.entry.scope,
                      ...(result.entry.private ? { private: true } : {}),
                      ...(kept(result.entry) ? {} : { text: result.entry.text }),
                    },
                  }
                : {}),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

const DOCUMENT_ID = /^[rpd][0-9a-z]{4,}$/
/** A record's or passage's id, which `add` may cite as its file with a quote from it. */
const QUOTABLE = /^\[?[rp][0-9a-z]{4,}\]?$/

// What the agent may keep as a document: the user's pasted text, or a file in this working tree or attached here.
function keepable(file: string, root: string, messages: readonly SessionV1.WithParts[]) {
  if (file === "message") {
    const pasted = SessionMemory.request(messages)
      .flatMap((message) => message.parts)
      .flatMap((part) =>
        part.type === "text" && !part.synthetic && !part.ignored && !SessionMemory.outside(part) ? [part.text] : [],
      )
      .toSorted((a, b) => b.length - a.length)[0]
    if (!pasted || pasted.length < 400) return "There is no long text in the user's message to keep."
    const first =
      pasted
        .split("\n")
        .find((line) => line.trim())
        ?.replace(/^#+\s*/, "")
        .trim() ?? "Pasted text"
    return { type: "text" as const, name: `${first.slice(0, 60)}.md`, text: pasted }
  }
  const target = path.resolve(root, file)
  const attached = messages.some(
    (message) =>
      message.info.role === "user" &&
      message.parts.some(
        (part) => part.type === "file" && part.url.startsWith("file:") && attachedPath(part.url) === target,
      ),
  )
  // Where the file really is: a link inside the working tree can point anywhere on the computer.
  if (!attached && !FSUtil.contains(FSUtil.realpath(root), FSUtil.realpath(target)))
    return "Vector keeps files from this repository or attached to this conversation."
  return { type: "path" as const, path: target, ...(attached ? { attached: true } : {}) }
}

function attachedPath(url: string) {
  try {
    return path.resolve(fileURLToPath(url))
  } catch {
    return undefined
  }
}

function keptLine(document: BrainSchema.Document, result: "queued" | "version" | "unchanged") {
  const name = `"${document.title}" as document [${document.id}]`
  if (result === "unchanged") return `Already kept as [${document.id}] ("${document.title}").`
  if (document.status === "held")
    return `Kept ${name} for the user's review (${holdReason(document.hold)}). It is not used until they approve it.`
  if (document.status === "failed")
    return `Vector could not read ${document.name}: ${document.error ?? "it could not be read"}.`
  if (document.status === "queued" || document.status === "reading")
    return `Reading ${name}; its cards come in once it is read.`
  return `Kept ${name}${result === "version" ? `, replacing version ${document.version - 1}` : ""}: ${document.stats.records} records from ${document.stats.sections} sections, searchable now. Its cards come in when they bear on a request, and get(${document.id}) shows its outline. The user can forget it in Settings > Memory.`
}

// Files whose lines are secrets, never evidence.
const SECRET_FILE =
  /(?:^|\/)(?:\.env(?:\.[\w.-]+)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_[a-z0-9]+|[\w.-]+\.(?:pem|key|p12|pfx)|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml|txt|env))$/i

// Evidence is checked here against the conversation and the files, never taken from the model's word: a quote must be
// the user's own, a file line must be on the default branch in a file the agent did not change in this session, and a
// command must be a check that failed and then passed in it. The brain then checks that the evidence states the memory.
// Checked evidence raises an entry's confidence and is shown with it; whether the entry goes into use is the session's
// outside content to decide, and personal memory and changes to the user's own entries still take their words.
const verify = Effect.fnUntraced(function* (
  params: Schema.Schema.Type<typeof Parameters>,
  ctx: Tool.Context<Metadata>,
  root: string,
  git: Git.Interface,
) {
  if (params.command)
    return {
      type: "check" as const,
      command: params.command,
      verified: SessionMemory.checked(ctx.messages, params.command),
    }
  if (params.file && params.quote) {
    const target = path.resolve(root, params.file)
    const file = path.relative(root, target).split(path.sep).join("/")
    // The file as the default branch has it, so a line the agent wrote this session, a file it created, or a pull
    // request checked out for review (whose commit is HEAD) cannot vouch for itself.
    const base =
      FSUtil.contains(root, target) && !SessionMemory.touched(ctx.messages, target, root)
        ? yield* git.defaultBranch(root)
        : undefined
    const committed = base ? yield* git.show(root, base.ref, file) : ""
    return {
      type: "file" as const,
      path: file,
      quote: params.quote,
      ...(committed ? { hash: createHash("sha256").update(committed).digest("hex").slice(0, 16) } : {}),
      verified:
        committed !== "" && normal(params.quote).length >= 6 && normal(committed).includes(normal(params.quote)),
    }
  }
  if (params.quote)
    return {
      type: "message" as const,
      quote: params.quote,
      // Personal memory follows the user everywhere, so it takes what they said in the message this step answers.
      verified: SessionMemory.quoted(
        params.scope === "personal" ? SessionMemory.request(ctx.messages) : ctx.messages,
        params.quote,
      ),
    }
  return undefined
})

function normal(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim()
}

function describe(entry: BrainSchema.Entry) {
  const from = entry.source ? ` (from ${path.basename(entry.source.file)})` : ""
  const scope = entry.paths.length ? ` [${entry.paths.slice(0, 3).join(", ")}]` : ""
  const stale = entry.stale ? " (may be out of date: its cited code changed)" : ""
  return `[${entry.id}] ${entry.kind}${scope}: ${entry.text}${from}${stale}`
}

function evidenceLine(item: BrainSchema.Evidence) {
  if (item.type === "message") return item.quote ? `the user said "${item.quote}"` : "a quote Vector could not check"
  if (item.type === "file")
    return item.quote ? `${item.path ?? "a file"}: "${item.quote}"` : `${item.path ?? "a file"}, unchecked`
  if (item.type === "check")
    return item.command ? `\`${item.command}\` passed after failing` : "a check Vector could not confirm"
  if (item.type === "file-item") return "a file"
  if (item.type === "document")
    return item.quote ? `[${item.path ?? "a document"}]: "${item.quote}"` : `[${item.path ?? "a document"}], unchecked`
  return "the user saved it"
}

// The words memory keeps, quoted, so the agent knows what memory says rather than assuming its own wording was saved.
// A personal entry's words stay out of the transcript.
function words(entry: BrainSchema.Entry, length = 300) {
  return kept(entry) ? "(personal memory)" : `"${entry.text.slice(0, length)}"`
}

// Personal memory and what was learned from a private document stay out of the transcript, which a guest may open or
// a model that may train may read later: each request fills their lines in where they are allowed.
function kept(entry: BrainSchema.Entry) {
  return entry.scope === "personal" || entry.private === true
}

const SKILL_ENTRY = "That is a learned skill. The user changes learned skills in Settings > Memory > Skills."

function written(result: Exclude<Brain.WriteResult, { type: "refused" }>, replaced: BrainSchema.Entry | undefined) {
  const id = result.entry.id
  // A different fact can share most of these words, so memory never replaces it on its own; the agent decides.
  const related =
    "related" in result && result.related
      ? ` Related ${result.related.id}: ${words(result.related, 120)}. If this replaces it, use update(${result.related.id}) instead.`
      : ""
  if (result.type === "added") return `Saved as ${id}, in use from the next request.${related}`
  if (result.type === "merged") {
    if (result.entry.status === "active") return `Already known as ${id}: ${words(result.entry)}`
    if (result.entry.status === "archived")
      return `Already in memory as ${id}, put away: ${words(result.entry)}. Only the user can bring it back, in Settings > Memory; ask them if it applies again.`
    return `Already in memory as ${id}, waiting for the user's review: ${words(result.entry)}`
  }
  if (result.type === "promoted") return `In use again as ${id}: ${words(result.entry)}`
  if (result.type === "superseded")
    return `Saved as ${id}, replacing ${result.previous}${replaced ? `: ${words(replaced, 120)}` : ""}.`
  return `Saved ${id} for the user's review (${holdReason(result.entry.hold)}). It is not used until they approve it.${related}`
}

// Why the agent may not change an entry that is not in use, or nothing when it is.
function inactive(entry: BrainSchema.Entry) {
  if (entry.status === "active") return undefined
  if (entry.status === "archived")
    return `${entry.id} was put away. Only the user can bring it back, in Settings > Memory; ask them if it applies again.`
  if (entry.status === "superseded")
    return `${entry.id} was replaced${entry.supersededBy ? ` by ${entry.supersededBy}` : ""}; change that one instead.`
  return `${entry.id} waits for the user's review, so only they can change it, in Settings > Memory.`
}

function withheld(entries: readonly BrainSchema.Entry[]) {
  const ids = entries.filter(kept).map((entry) => entry.id)
  return ids.length ? { [SessionMemory.PERSONAL]: ids } : {}
}

function holdReason(hold: BrainSchema.Hold | undefined) {
  if (hold === "web")
    return "this session read web content, holds an imported transcript or an issue's text, or ran a command that reaches outside this computer"
  if (hold === "mcp") return "this session ran an MCP tool or an MCP server's prompt"
  if (hold === "subagent") return "this session took a subagent's report"
  if (hold === "guest") return "an invited guest is in this session"
  if (hold === "untrusted-repository") return "this repository's settings are not trusted"
  if (hold === "hidden-unicode") return "it had hidden characters"
  return "it reads like an instruction to the agent"
}

function refused(action: string, message: string) {
  return { title: "Memory not changed", output: message, metadata: { action, result: "refused" } }
}
