export * as SessionMemory from "./memory"

import path from "path"
import { fileURLToPath } from "url"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { BrainAnchor } from "@vectordevai/core/brain/anchor"
import { BrainFuse } from "@vectordevai/core/brain/fuse"
import { BrainPaths } from "@vectordevai/core/brain/paths"
import { BrainSchema } from "@vectordevai/core/brain/schema"
import { BrainSkill } from "@vectordevai/core/brain/skill"
import { ChildEnvironment } from "@vectordevai/core/child-environment"
import { FSUtil } from "@vectordevai/core/fs-util"
import { LocalCommand } from "@vectordevai/core/local-mode/command"
import { attachedMemory, links, type Asking } from "./instruction"
import { SessionTaskSize } from "./task-size"

// What the session runtime and the memory tool read from a conversation to use and to grow Vector's memory: the user's
// own words (evidence for what they said), the checks that went from failing to passing (evidence for a lesson), the
// memory already in the conversation (never sent twice), and whether outside content came in (memory waits for the
// user then). All of it is read from the history, so it holds across restarts and is the same in every engine.

/** Metadata key of the synthetic part that carries a request message's recalled memory. */
export const RECALL = "vector.memory.recall"

/**
 * Metadata key of a text part a slash command wrote: its template, an MCP server's prompt, a skill, or what its shell
 * snippets printed. The value says which arguments the user typed, which spans of them they pasted, and whether the
 * text came from outside.
 */
export const COMMAND = "vector.command"

/** Metadata key of a memory tool result's personal entries, which the transcript keeps as ids only. */
export const PERSONAL = "vector.memory.personal"

/** How a memory tool result stands in for a personal entry; each request fills the line in while that is allowed. */
export function withheld(id: string) {
  return `[${id}] (personal memory)`
}

/**
 * Metadata key of the text part that marks an attachment for Vector to keep as a document: `{ mode, part }`, where
 * `part` is the attached file part's id (or `filename` its name). "keep" sends the file too; "instead" keeps it in memory
 * in place of sending it, so the model gets its outline and cards rather than its pages. A marker has no text of its
 * own, so it costs nothing on the request.
 */
export const REMEMBER = "vector.memory.remember"

/**
 * Metadata key of what document knowledge a part stands for, by id, so the transcript never keeps a document's words:
 * the outline of a document kept from an attachment (`document`, `part`), or the cards and passages a memory tool
 * result showed (`cards`, `get`). Each request renders them again from the brain, so a forgotten document is gone from
 * old sessions too, and a private one stays out where private documents may not go.
 */
export const KNOWLEDGE = "vector.memory.knowledge"

/**
 * Metadata key of a `skill` tool part that loaded a learned skill: `{ id, version, checks }`. The transcript keeps only
 * the placeholder; each request fills the procedure in from that version where personal memory may go.
 */
export const SKILL = "vector.memory.skill"

/**
 * A client's part metadata without the keys only the engine writes. Recall, document knowledge, personal ids and learned
 * skill loads record what a request was given; a client's copy of them would skip recall for its request, or pass off
 * ids it was never shown as delivered (and so as verified citations).
 */
export function admitted(metadata: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(metadata).filter(
      ([key]) => key !== RECALL && key !== KNOWLEDGE && key !== PERSONAL && key !== SKILL,
    ),
  )
}

/** The learned skill a `skill` tool part loaded, with the checks it was loaded for. */
export function skill(part: SessionV1.Part) {
  if (part.type !== "tool" || part.tool !== "skill" || part.state.status !== "completed") return undefined
  const value = part.state.metadata?.[SKILL]
  if (!value || typeof value !== "object" || !("id" in value) || !("version" in value)) return undefined
  if (typeof value.id !== "string" || typeof value.version !== "number") return undefined
  const checks: unknown[] = "checks" in value && Array.isArray(value.checks) ? value.checks : []
  return {
    id: value.id,
    version: value.version,
    checks: checks.filter((check): check is string => typeof check === "string"),
  }
}

/** The learned skills a request's turn loaded, each once, with when it was loaded. */
export function skills(turn: readonly SessionV1.WithParts[]) {
  const loads = turn.flatMap((message) =>
    message.parts.flatMap((part) => {
      const loaded = skill(part)
      return loaded && part.type === "tool" && part.state.status === "completed"
        ? [{ ...loaded, at: part.state.time.start }]
        : []
    }),
  )
  return loads.filter((load, index) => loads.findIndex((item) => item.id === load.id) === index)
}

/**
 * How each loaded skill fared, by its own checks alone: `pass` when one of them ran after the load and its last run
 * passed, `fail` when the last run of one failed or the judge's last verdict after it ran was FAIL or INCONCLUSIVE,
 * and `ignored` when none of them ran after the load. Another check going green says nothing about the skill.
 */
export function skillOutcomes(
  turn: readonly SessionV1.WithParts[],
  loads: ReturnType<typeof skills>,
): BrainSkill.Outcome[] {
  const all = runs(turn)
  const verdicts = judges(turn)
  return loads.map((load) => {
    const targets = new Set(load.checks.map((command) => checkTarget(normal(command))))
    const ran = [
      ...Map.groupBy(
        all.filter((run) => run.at >= load.at && targets.has(checkTarget(run.command))),
        (run) => checkTarget(run.command),
      ).values(),
    ].map((same) => same.at(-1)!)
    const last = Math.max(0, ...ran.map((run) => run.at))
    const verdict = verdicts.findLast((item) => item.at >= last)?.verdict
    const outcome =
      ran.length === 0
        ? ("ignored" as const)
        : ran.some(failing) || verdict === "FAIL" || verdict === "INCONCLUSIVE"
          ? ("fail" as const)
          : ran.some((run) => run.exit === 0)
            ? ("pass" as const)
            : ("ignored" as const)
    return { id: load.id, version: load.version, outcome }
  })
}

/**
 * Whether a turn ended with its work failing: the judge's last verdict was FAIL or INCONCLUSIVE, or a test, lint,
 * build or typecheck run was still failing the last time it ran.
 */
export function failed(turn: readonly SessionV1.WithParts[]) {
  const verdict = judges(turn).at(-1)?.verdict
  if (verdict === "FAIL" || verdict === "INCONCLUSIVE") return "judge-fail" as const
  const checks = runs(turn).filter((run) => CHECK.test(run.command))
  const ended = [...Map.groupBy(checks, (run) => checkTarget(run.command)).values()].map((same) => same.at(-1)!)
  return ended.some(failing) ? ("check-fail" as const) : undefined
}

/**
 * What one run showed, for drafting a learned skill: the check that went from failing to passing in the request that
 * started at `start` (its raw command, as the agent typed it, and the tail of its failing output), the read-only
 * helper commands run on the way, and the files it read and changed, relative to `root`. A run the judge passed with
 * no such check gives a trace without one. A check that went green but that `BrainSkill.check` refuses (`make deploy`)
 * gives no trace at all.
 */
export function trace(
  messages: readonly SessionV1.WithParts[],
  start: number,
  root: string,
  loaded?: BrainSkill.Trace["loaded"],
): BrainSkill.Trace | undefined {
  const index = messages.findLastIndex(
    (message) => message.info.role === "user" && asked(message) && message.info.time.created <= start,
  )
  const request = messages[index]
  if (!request) return undefined
  const turn = messages.slice(index)
  const all = runs(messages)
  const found = [
    ...Map.groupBy(
      all.filter((run) => CHECK.test(run.command)),
      (run) => checkTarget(run.command),
    ).values(),
  ]
    .flatMap((same) => {
      if (same.at(-1)?.exit !== 0) return []
      const pass = same.findLastIndex(
        (run, at) => run.at >= start && run.exit === 0 && at > 0 && failing(same[at - 1]!),
      )
      if (pass < 0) return []
      // The failures this pass ended, from the first of them.
      const first = same.slice(0, pass).findLastIndex((run) => !failing(run)) + 1
      return [{ pass: same[pass]!, failure: same[pass - 1]!, first: same[first]! }]
    })
    .toSorted((a, b) => a.pass.at - b.pass.at)
  const allowed = found.filter((item) => BrainSkill.check(item.pass.raw))
  if (found.length > 0 && allowed.length === 0) return undefined
  const chosen = allowed.at(-1)
  if (!chosen && !judged(turn)) return undefined
  const from = Math.max(chosen?.first.at ?? start, start)
  const to = chosen?.pass.at ?? Infinity
  const files = (list: readonly string[]) =>
    [
      ...new Set(
        list
          .map((file) => BrainPaths.relative(root, file))
          .filter((file) => file && !file.startsWith("..") && !path.isAbsolute(file)),
      ),
    ].slice(0, BrainSkill.LIMIT.paths)
  return {
    sessionID: request.info.sessionID,
    requestID: request.info.id,
    signal: chosen ? "recovered" : "judged",
    ...(chosen
      ? {
          check: {
            command: chosen.pass.raw,
            target: BrainSkill.target(chosen.pass.raw),
            failure: chosen.failure.output.trim().slice(-BrainSkill.LIMIT.failure),
          },
        }
      : {}),
    commands: [
      ...new Set(
        all.filter((run) => run.at >= from && run.at < to && BrainSkill.helper(run.raw)).map((run) => run.raw),
      ),
    ].slice(0, BrainSkill.LIMIT.commands),
    edited: files(edited(turn)),
    read: files(
      turn.flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "tool" &&
          part.tool === "read" &&
          part.state.status === "completed" &&
          typeof part.state.input.filePath === "string"
            ? [part.state.input.filePath]
            : [],
        ),
      ),
    ),
    closing: SessionTaskSize.closingText(turn).slice(-600),
    ...(loaded ? { loaded } : {}),
    at: chosen?.pass.at ?? turn.at(-1)?.info.time.created ?? start,
  }
}

/** Why a document's content counts as outside content: how it came in. */
const OUTSIDE: readonly BrainSchema.Hold[] = ["web", "mcp", "subagent", "guest", "untrusted-repository"]

/**
 * Whether what a session writes to memory waits for the user, and whether it is private: a guest's session, an
 * untrusted repository, outside content in the session (`taint`) or a document read from outside holds it, and a
 * private document read in it (or one forgotten since) makes it private. `sources` are the documents the session read,
 * as `BrainKnowledge.sources` resolved them, and `missing` how many of them are gone. The memory tool and the skill
 * learner both decide with this.
 */
export function writeHold(input: {
  readonly guest: boolean
  /** This Vector was started by an agent, a program it ran or Vector's own terminal (`agentStarted`). */
  readonly agent: boolean
  readonly held: boolean
  readonly messages: readonly SessionV1.WithParts[]
  readonly sources: readonly { readonly hold?: BrainSchema.Hold; readonly visibility: string }[]
  readonly missing: number
}): { readonly hold?: BrainSchema.Hold; readonly private: boolean } {
  const hold = input.guest
    ? ("guest" as const)
    : input.agent
      ? ("subagent" as const)
      : input.held
        ? ("untrusted-repository" as const)
        : (taint(input.messages) ??
          input.sources.flatMap((document) =>
            document.hold && OUTSIDE.includes(document.hold) ? [document.hold] : [],
          )[0])
  return {
    ...(hold ? { hold } : {}),
    private: input.missing > 0 || input.sources.some((document) => document.visibility === "private"),
  }
}

/**
 * Whether an agent started this Vector: a `vector run` from an agent's shell (or a program it ran, or Vector's own
 * terminal) carries the marker every child of a process that runs agents gets. Its prompt is text that agent wrote, not
 * the owner's, whatever the outer session read, so what its sessions teach waits for the owner as a subagent's does,
 * and never counts as a second, independent sighting. The marker is advisory: a program that clears its children's
 * environment drops it, and the shell asks before a command that does (PermissionPolicy.AGENT_MARKER).
 */
export function agentStarted() {
  return process.env[ChildEnvironment.AGENT_MARKER] !== undefined
}

/** How a memory tool result stands in for a document card or passage; each request renders it again. */
export function document(id: string) {
  return `[${id}] (document)`
}

/** The attachments a message marked for Vector to keep, with their file parts. */
export function remember(message: SessionV1.WithParts) {
  return message.parts.flatMap((part) => {
    if (part.type !== "text") return []
    const value = part.metadata?.[REMEMBER]
    if (!value || typeof value !== "object" || !("mode" in value)) return []
    const mode = value.mode === "instead" ? ("instead" as const) : value.mode === "keep" ? ("keep" as const) : undefined
    const id = "part" in value && typeof value.part === "string" ? value.part : undefined
    const name = "filename" in value && typeof value.filename === "string" ? value.filename : undefined
    const file = message.parts.find(
      (item): item is SessionV1.FilePart =>
        item.type === "file" && (id ? item.id === id : name !== undefined && item.filename === name),
    )
    return mode && file ? [{ mode, file, marker: part.id }] : []
  })
}

/** What document knowledge a part stands for, when it does. */
export function knowledge(part: SessionV1.Part) {
  const value =
    part.type === "text" && part.synthetic
      ? part.metadata?.[KNOWLEDGE]
      : part.type === "tool" && part.tool === "memory" && part.state.status === "completed"
        ? part.state.metadata?.[KNOWLEDGE]
        : undefined
  if (!value || typeof value !== "object") return undefined
  const strings = (list: unknown) =>
    Array.isArray(list) ? list.filter((id: unknown): id is string => typeof id === "string") : []
  const gets = "get" in value && Array.isArray(value.get) ? value.get : []
  return {
    document: "document" in value && typeof value.document === "string" ? value.document : undefined,
    part: "part" in value && typeof value.part === "string" ? value.part : undefined,
    cards: "cards" in value ? strings(value.cards) : [],
    get: (gets as unknown[]).flatMap((item) =>
      item && typeof item === "object" && "id" in item && typeof item.id === "string"
        ? [
            {
              id: item.id,
              ...("part" in item && typeof item.part === "string" ? { part: item.part } : {}),
              budget: "budget" in item && typeof item.budget === "number" ? item.budget : 600,
            },
          ]
        : [],
    ),
    tokens: "tokens" in value && typeof value.tokens === "number" ? value.tokens : 0,
  }
}

// Tools whose output is written by Vector or by the user's own repository. Anything else (web fetch and search, the
// browser, Vector Cloud logs, MCP servers, a subagent's report of its own work) brings in content from outside.
const LOCAL_TOOLS = new Set([
  "bash",
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "apply_patch",
  "todowrite",
  "question",
  "skill",
  "memory",
  "escalate",
  "lsp",
  "plan_exit",
  "invalid",
  "StructuredOutput",
])

const DELEGATION_TOOLS = new Set(["task", "workflow", "task_manage", "send_teammate_message"])

// Tools whose output is the web's: pages, search results, the browsers, Vector Cloud's logs, and every research tool
// (a research run reads the web by design, and its notes and reports quote pages; research_browser is the research
// agents' own browser, and research is the build agent's way to start a run).
const WEB_TOOLS = new Set([
  "webfetch",
  "websearch",
  "browser",
  "vector_cloud",
  "research",
  "research_plan",
  "research_search",
  "research_read",
  "research_browser",
  "research_note",
  "research_report",
])

// Agents whose sessions take in the web by design: the research lead and its workers. Their writes wait for the user
// from the first step, before any research tool has run.
const WEB_AGENTS = new Set(["research", "researcher"])

/** Metadata key of a task call's part that says what the subagent it ran took in, so its hold passes up. */
export const HOLD = "hold"

/**
 * Metadata for a note or message part from another agent that carries what that agent took in (D.6): web or MCP
 * content marks the part as outside content, keeping which, so the recipient is held for the same reason.
 */
export function carried(hold: BrainSchema.Hold | undefined): Record<string, string> {
  return hold === "web" || hold === "mcp" ? { [BrainSchema.OUTSIDE]: "subagent", [HOLD]: hold } : {}
}

// Note parts Vector writes about the work a subagent did: its report, its note up, its waiting, its interruption.
const SUBAGENT_NOTES = ["taskNotification", "taskMessage", "taskAttention", "taskInterrupted"]

/**
 * What the user typed in a message, without Vector's synthetic notes or attached file contents. A slash command's text
 * is someone else's words (a template, an MCP server's prompt, a skill, a snippet's output), so of it only the
 * arguments the user typed count, and text from outside (an imported transcript, an issue) or that the user pasted (an
 * email, a log, someone else's message), as a part of its own or a span of a typed one or of a command's arguments,
 * does not count at all: Vector learns what the user likes only from this.
 */
export function typed(message: SessionV1.WithParts) {
  return own(message, true)
}

/**
 * What the user sent in a message themselves: what they typed and what they pasted into it, without Vector's synthetic
 * notes, attached file contents, text from outside or a slash command's template. Where an address or a question came
 * from reads this, not `typed`: a link the user pasted came from them, though Vector learns nothing from it.
 */
export function said(message: SessionV1.WithParts) {
  return own(message, false)
}

function own(message: SessionV1.WithParts, unpaste: boolean) {
  return message.parts
    .flatMap((part) => {
      if (part.type !== "text" || part.synthetic || part.ignored) return []
      // Where text from outside sat, two blank lines: what the user typed after it is a paragraph of its own, and not
      // the one a line before it such as "Here is the email:" introduces.
      if (outside(part)) return [PASTE_BREAK]
      const found = command(part)
      if (!unpaste) return [found ? found.arguments : part.text]
      return [
        found ? unpasted(found.arguments, found.pasted) : unpasted(part.text, part.metadata?.[BrainSchema.PASTED]),
      ]
    })
    .join("\n")
    .trim()
}

// A typed part's text without the lines the user pasted into it, each left as two blank lines so the words on either
// side neither join nor run into a quote across it, and a line before the paste that introduces it ("Bob wrote:")
// introduces nothing the user typed. A span takes the whole lines it touches: a clause typed around a pasted name
// ("never push to <main> without a review") would otherwise be learned cut short. Spans that do not fit the text leave
// nothing of it: a part that says it holds pasted text, but not where, vouches for none of its words.
function unpasted(text: string, spans: unknown) {
  if (spans === undefined) return text
  if (!Array.isArray(spans) || !spans.every((span) => fits(span, text.length))) return ""
  const cut = (spans as [number, number][])
    .flatMap(([start, end]): [number, number][] => {
      const inner = text.slice(start, end)
      const from = start + inner.length - inner.trimStart().length
      const to = end - (inner.length - inner.trimEnd().length)
      if (from >= to) return []
      const after = text.indexOf("\n", to)
      return [[from === 0 ? 0 : text.lastIndexOf("\n", from - 1) + 1, after === -1 ? text.length : after]]
    })
    .toSorted((a, b) => a[0] - b[0])
    .reduce(
      (out, span) => ({
        at: Math.max(out.at, span[1]),
        text: span[0] > out.at ? `${out.text}${text.slice(out.at, span[0])}${PASTE_BREAK}` : out.text,
      }),
      { at: 0, text: "" },
    )
  return cut.text + text.slice(cut.at)
}

const PASTE_BREAK = "\n\n\n"

function fits(span: unknown, length: number) {
  return (
    Array.isArray(span) &&
    span.length === 2 &&
    Number.isInteger(span[0]) &&
    Number.isInteger(span[1]) &&
    span[0] >= 0 &&
    span[0] < span[1] &&
    span[1] <= length
  )
}

/** What a message asks for, a slash command's text included: what recall reads a request by. */
export function asked(message: SessionV1.WithParts) {
  return message.parts
    .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
    .join("\n")
    .trim()
}

/** Where a slash command's text part came from, or nothing for a part the user typed. */
export function command(part: SessionV1.Part) {
  if (part.type !== "text") return undefined
  const value = part.metadata?.[COMMAND]
  if (!value || typeof value !== "object") return undefined
  return {
    arguments: "arguments" in value && typeof value.arguments === "string" ? value.arguments : "",
    /** The spans of the arguments the user pasted, as the composer sent them. */
    pasted: "pasted" in value ? value.pasted : undefined,
    outside: "outside" in value && (value.outside === "web" || value.outside === "mcp") ? value.outside : undefined,
  }
}

/**
 * Whether a part's text came from outside this conversation though it may sit in a "user" message: a transcript
 * imported as passive history, the issue and pull request text the GitHub agent was given, a resource an editor
 * embedded, or what was piped into `vector run`.
 */
export function outside(part: SessionV1.Part) {
  return part.type === "text" && part.metadata?.[BrainSchema.OUTSIDE] !== undefined
}

/**
 * The document knowledge this conversation took in, by id: the cards recalled into its messages, the outlines of the
 * attachments it kept, and the cards and passages the memory tool showed. What the agent learns after reading them
 * takes their documents' privacy, and waits for the user when one came from outside.
 */
export function documents(messages: readonly SessionV1.WithParts[]) {
  return [
    ...new Set(
      messages.flatMap((message) =>
        message.parts.flatMap((part) => {
          const known = knowledge(part)
          return [
            ...(recall(part)?.cards ?? []),
            ...(known?.cards ?? []),
            ...(known?.get.map((item) => item.id) ?? []),
            // A tool result naming a document only says it was kept; an outline the request carried showed it.
            ...(part.type === "text" && known?.document ? [known.document] : []),
          ]
        }),
      ),
    ),
  ]
}

/** The personal entries a memory tool result stands in for. */
export function personal(part: SessionV1.Part) {
  if (part.type !== "tool" || part.tool !== "memory" || part.state.status !== "completed") return []
  const ids = part.state.metadata?.[PERSONAL]
  return Array.isArray(ids) ? ids.filter((id: unknown): id is string => typeof id === "string") : []
}

/** The files a message attached, as paths. */
export function files(message: SessionV1.WithParts) {
  return message.parts.flatMap((part) => {
    if (part.type !== "file" || !part.url.startsWith("file:")) return []
    try {
      return [fileURLToPath(part.url)]
    } catch {
      return []
    }
  })
}

/**
 * The memory a part recalled: every entry's id, and which of them are the user's personal memory. Personal lines are
 * not saved with the part, so each request fills them in again while personal memory is allowed.
 */
export function recall(part: SessionV1.Part) {
  if (part.type !== "text" || !part.synthetic) return undefined
  const value = part.metadata?.[RECALL]
  if (!value || typeof value !== "object" || !("ids" in value) || !Array.isArray(value.ids)) return undefined
  const strings = (list: unknown) =>
    Array.isArray(list) ? list.filter((id: unknown): id is string => typeof id === "string") : []
  return {
    ids: strings(value.ids),
    personal: "personal" in value ? strings(value.personal) : [],
    newest: "newest" in value && value.newest === true,
    /** Which of `ids` are document cards, which the saved text never holds. */
    cards: "cards" in value ? strings(value.cards) : [],
    /** How the owner reviews, for a Vectorscope reviewer: rendered as its own fenced block. */
    review: "review" in value && value.review === true,
  }
}

/**
 * The memory already in this conversation: recalled into a message, attached to a read result, a document card or
 * passage the memory tool showed, or a card a code-link line named.
 */
export function injected(messages: readonly SessionV1.WithParts[]) {
  const recalled = messages.flatMap((message) => message.parts.flatMap((part) => recall(part)?.ids ?? []))
  const shown = messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      const known = knowledge(part)
      return [
        ...(known ? [...known.cards, ...known.get.map((item) => item.id)] : []),
        ...links(part).flatMap((item) => item.ids),
      ]
    }),
  )
  return new Set([...recalled, ...shown, ...attachedMemory([...messages])])
}

/** Who a tool call's code-link lines are for, from what the session runtime told the tool. */
export function linking(ctx: {
  readonly sessionID: string
  readonly extra?: { readonly [key: string]: unknown }
  readonly messages: readonly SessionV1.WithParts[]
}): Asking {
  const size = ctx.extra?.taskSize
  const tier =
    size && typeof size === "object" && "tier" in size && typeof size.tier === "string" ? size.tier : undefined
  return {
    sessionID: ctx.sessionID,
    // Without the runtime's word that personal memory may go to this model, private documents stay out.
    personal: ctx.extra?.personal === true,
    ...(tier === "chat" || tier === "light" || tier === "standard" || tier === "thorough" ? { tier } : {}),
    exclude: injected(ctx.messages),
  }
}

/** Messages the working set is read from. */
const WORKING = 20

/**
 * What a request is working on, for recall to bring in what is linked to it: files the last 20 messages edited, wrote,
 * patched, attached or read, files and symbols the request names (in what the user pasted too, such as a stack trace),
 * and the working tree's changed files. At most `BrainFuse.SEEDS`, strongest first; a file touched several ways counts
 * the strongest way.
 */
export function workingSet(messages: readonly SessionV1.WithParts[], root: string, changed: readonly string[] = []) {
  const relative = (file: string) =>
    (path.isAbsolute(file) ? path.relative(root, file) : file).split(path.sep).join("/").replace(/^\.\//, "")
  const recent = messages.slice(-WORKING)
  const touched = recent.flatMap((message) =>
    message.parts.flatMap((part): BrainFuse.Seed[] => {
      if (part.type === "file" && part.url.startsWith("file:"))
        return files({ ...message, parts: [part] }).map((file) => ({
          path: relative(file),
          weight: BrainFuse.SEED.attached,
        }))
      if (part.type !== "tool") return []
      const input = part.state.input
      if ((part.tool === "edit" || part.tool === "write") && typeof input.filePath === "string")
        return [{ path: relative(input.filePath), weight: BrainFuse.SEED.edited }]
      if (part.tool === "read" && typeof input.filePath === "string")
        return [{ path: relative(input.filePath), weight: BrainFuse.SEED.read }]
      if (part.tool === "apply_patch" && typeof input.patchText === "string")
        return [...input.patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => ({
          path: relative(match[1]!.trim()),
          weight: BrainFuse.SEED.edited,
        }))
      return []
    }),
  )
  const asked = request(messages).flatMap((message) =>
    BrainAnchor.names({ text: said(message) }).flatMap((name): BrainFuse.Seed[] => {
      if (name.kind === "path") return [{ path: relative(name.text), weight: BrainFuse.SEED.attached }]
      if (name.kind === "symbol" || name.kind === "env") return [{ symbol: name.text, weight: BrainFuse.SEED.symbol }]
      return []
    }),
  )
  const seeds: BrainFuse.Seed[] = [
    ...touched,
    ...asked,
    ...changed.map((file) => ({ path: relative(file), weight: BrainFuse.SEED.changed })),
  ]
  const strongest = new Map<string, BrainFuse.Seed>()
  // Newest first, so a cap keeps what the request touched last.
  for (const seed of seeds.toReversed()) {
    const key = seed.path !== undefined ? `path:${seed.path}` : `symbol:${seed.symbol}`
    if ((strongest.get(key)?.weight ?? 0) < seed.weight) strongest.set(key, seed)
  }
  return [...strongest.values()].toSorted((a, b) => b.weight - a.weight).slice(0, BrainFuse.SEEDS)
}

/** Whether the message already carries its recall, so a later step of the same request never adds another. */
export function recalled(message: SessionV1.WithParts) {
  return message.parts.some((part) => part.type === "text" && part.synthetic && part.metadata?.[RECALL] !== undefined)
}

function normal(text: string) {
  return text
    .toLowerCase()
    .replace(/[\s"'`]+/g, " ")
    .trim()
}

/** The request message this step answers: what the user sent last. */
export function request(messages: readonly SessionV1.WithParts[]) {
  return messages.filter((message) => message.info.role === "user" && asked(message)).slice(-1)
}

/** Whether the user said this, word for word, in a message of this conversation. */
export function quoted(messages: readonly SessionV1.WithParts[], quote: string) {
  const wanted = normal(quote)
  // A word or two ("yes", "thanks") could be anyone's; evidence has to say something.
  if (wanted.length < 12) return false
  return messages.some((message) => message.info.role === "user" && normal(typed(message)).includes(wanted))
}

// `command` is lowercased and unquoted for matching runs to a check; `raw` is what the agent typed, which a learned
// skill keeps.
type Run = {
  readonly command: string
  readonly raw: string
  readonly exit: number | undefined
  readonly at: number
  readonly output: string
}

function runs(messages: readonly SessionV1.WithParts[]): Run[] {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      if (part.type !== "tool" || part.tool !== "bash") return []
      if (part.state.status !== "completed" && part.state.status !== "error") return []
      const command = typeof part.state.input?.command === "string" ? part.state.input.command : undefined
      if (!command) return []
      const exit = part.state.status === "completed" ? part.state.metadata?.exit : 1
      return [
        {
          command: normal(command),
          raw: command,
          exit: typeof exit === "number" ? exit : undefined,
          at: part.state.time.start,
          output: part.state.status === "completed" ? part.state.output : part.state.error,
        },
      ]
    }),
  )
}

function failing(run: Run) {
  return run.exit !== undefined && run.exit !== 0
}

// The verdicts Vector's judge gave in these messages, oldest first.
function judges(messages: readonly SessionV1.WithParts[]) {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      if (part.type !== "tool") return []
      const judge = part.metadata?.judge
      if (!judge || typeof judge !== "object" || !("verdict" in judge) || typeof judge.verdict !== "string") return []
      return [{ verdict: judge.verdict, at: part.state.status === "pending" ? 0 : part.state.time.start }]
    }),
  )
}

/**
 * The check a lowercased, unquoted command runs, without its flags: `bun test --isolate a.test.ts` checks what
 * `bun test a.test.ts` did.
 */
export function checkTarget(command: string) {
  return command
    .split(" ")
    .filter((word) => word && !word.startsWith("-"))
    .join(" ")
}

// The checks a lesson can be learned from: test, lint, build and typecheck runners. `test -f x` fails and then passes
// once `touch x` ran, and proves nothing.
const CHECK =
  /(?:^|[\s;&|(])(?:(?:bun|npm|pnpm|yarn|deno)\s+(?:run\s+)?(?:test|lint|build|check|typecheck|tsc|e2e|verify|spec)[\w:.-]*|(?:bunx|npx|pnpx|pnpm\s+exec|yarn\s+exec|npm\s+exec)\s+(?:tsc|vitest|jest|eslint|biome|playwright|prettier|mocha|oxlint)|tsc|tsgo|vitest|jest|pytest|mypy|pyright|ruff|eslint|biome|oxlint|rspec|phpunit|xcodebuild|mvn|gradlew?|\.\/gradlew|cargo\s+(?:test|check|build|clippy|nextest)|go\s+(?:test|build|vet)|dotnet\s+(?:test|build)|swift\s+(?:test|build)|mix\s+test|make|python3?\s+-m\s+(?:pytest|unittest|mypy))(?=\s|$)/

/**
 * Whether this command passed in the conversation after the same check failed earlier in it: the outcome a lesson
 * about it is worth remembering for. A check that only ever passed proves nothing was learned.
 */
export function checked(messages: readonly SessionV1.WithParts[], command: string) {
  const wanted = normal(command)
  if (!wanted || !CHECK.test(wanted)) return false
  const all = runs(messages)
  const passed = all.findLastIndex((run) => run.exit === 0 && (run.command === wanted || run.command.includes(wanted)))
  if (passed < 0) return false
  const target = checkTarget(all[passed]!.command)
  return all
    .slice(0, passed)
    .some((run) => run.exit !== undefined && run.exit !== 0 && checkTarget(run.command) === target)
}

/**
 * Whether a check went from failing to passing in the request that started at `since`: a test, lint, build or typecheck
 * run that passed then, where the run of the same check before it failed (in this request or an earlier one), and that
 * still passed the last time it ran. A check that only ever passed proves nothing, nor does one broken again since.
 */
export function recovered(messages: readonly SessionV1.WithParts[], since: number) {
  const all = runs(messages).filter((run) => CHECK.test(run.command))
  const targets = new Set(all.filter((run) => run.at >= since).map((run) => checkTarget(run.command)))
  return [...targets].some((target) => {
    const same = all.filter((run) => checkTarget(run.command) === target)
    if (same.at(-1)?.exit !== 0) return false
    return same.some(
      (run, index) =>
        run.at >= since &&
        run.exit === 0 &&
        index > 0 &&
        same[index - 1]!.exit !== undefined &&
        same[index - 1]!.exit !== 0,
    )
  })
}

/** Whether Vector's judge passed the work in these messages. */
export function judged(messages: readonly SessionV1.WithParts[]) {
  return messages.some((message) =>
    message.parts.some((part) => {
      if (part.type !== "tool") return false
      const judge = part.metadata?.judge
      return Boolean(judge && typeof judge === "object" && "verdict" in judge && judge.verdict === "PASS")
    }),
  )
}

// Ids of memory and document knowledge in the brain's base32: memory entries (m, 5 or 13), file entries (f, 6), records
// and passages (r, p, 12) and documents (d, 8). Exact lengths keep words such as "[demand]" from reading as one.
const ID =
  "(?:m(?:[0-9a-hjkmnp-tv-z]{13}|[0-9a-hjkmnp-tv-z]{5})|f[0-9a-hjkmnp-tv-z]{6}|[rp][0-9a-hjkmnp-tv-z]{12}|d[0-9a-hjkmnp-tv-z]{8})"
const CITATION = new RegExp(`\\[(${ID})\\]`, "g")

/**
 * Every id these messages gave the model: what recall put in a request, what memory tool calls returned or printed,
 * the outline of a kept attachment, and what code-link lines named. A citation is verified only against these.
 */
export function delivered(messages: readonly SessionV1.WithParts[]) {
  return new Set([
    ...injected(messages),
    ...messages.flatMap((message) =>
      message.parts.flatMap((part) => {
        const known = knowledge(part)
        if (part.type === "text") return part.synthetic && known?.document ? [known.document] : []
        if (part.type !== "tool" || part.tool !== "memory" || part.state.status !== "completed") return []
        return [
          ...personal(part),
          ...(typeof part.state.metadata?.id === "string" ? [part.state.metadata.id] : []),
          ...[...part.state.output.matchAll(CITATION)].flatMap((match) => (match[1] ? [match[1]] : [])),
        ]
      }),
    ),
  ])
}

/**
 * Whether a request's turn is over: its last message is the agent's finished answer. A request admitted while the run
 * before it was ending has none yet, and is credited once its own run answers it.
 */
export function finished(turn: readonly SessionV1.WithParts[]) {
  const last = turn.at(-1)?.info
  return (
    last?.role === "assistant" &&
    last.time.completed !== undefined &&
    last.finish !== undefined &&
    last.finish !== "tool-calls"
  )
}

/** The ids an answer cited as [id] that it was given: a made-up or mistyped id is no citation. */
export function cited(text: string, given: ReadonlySet<string>) {
  return [...new Set([...text.matchAll(CITATION)].flatMap((match) => (match[1] ? [match[1]] : [])))].filter((id) =>
    given.has(id),
  )
}

/** What the agent's answers in these messages say, Vector's own notes left out. */
export function answered(messages: readonly SessionV1.WithParts[]) {
  return messages
    .filter((message) => message.info.role === "assistant")
    .flatMap((message) => message.parts.flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : [])))
    .join("\n")
}

/** What the agent opened with the memory tool's get: an entry, record, passage or document, by id. */
export function fetched(messages: readonly SessionV1.WithParts[]) {
  return [
    ...new Set(
      messages.flatMap((message) =>
        message.parts.flatMap((part) => {
          if (part.type !== "tool" || part.tool !== "memory" || part.state.status !== "completed") return []
          if (part.state.input.action !== "get") return []
          return [
            ...(knowledge(part)?.get.map((item) => item.id) ?? []),
            ...(typeof part.state.metadata?.id === "string" ? [part.state.metadata.id] : []),
          ]
        }),
      ),
    ),
  ]
}

/** The files the agent edited, wrote or patched in these messages, as it named them. */
export function edited(messages: readonly SessionV1.WithParts[]) {
  return [
    ...new Set(
      messages.flatMap((message) =>
        message.parts.flatMap((part) => {
          if (part.type !== "tool" || part.state.status !== "completed") return []
          const input = part.state.input
          if ((part.tool === "edit" || part.tool === "write") && typeof input.filePath === "string")
            return [input.filePath]
          if (part.tool === "apply_patch" && typeof input.patchText === "string")
            return [...input.patchText.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)].map((match) =>
              match[1]!.trim(),
            )
          return []
        }),
      ),
    ),
  ]
}

/**
 * Whether the agent changed this file in the conversation: edited, wrote or patched it, or named it in a shell
 * command. A file the agent changed cannot vouch for a memory, because the agent could have written the line itself.
 */
export function touched(messages: readonly SessionV1.WithParts[], file: string, root: string) {
  const relative = path.relative(root, file).split(path.sep).join("/")
  const name = path.basename(file)
  return messages.some((message) =>
    message.parts.some((part) => {
      if (part.type !== "tool") return false
      const input = part.state.input
      if (part.tool === "edit" || part.tool === "write")
        return typeof input.filePath === "string" && path.resolve(root, input.filePath) === file
      if (part.tool === "apply_patch") return typeof input.patchText === "string" && input.patchText.includes(relative)
      if (part.tool === "bash") return typeof input.command === "string" && input.command.includes(name)
      return false
    }),
  )
}

/**
 * Why memory learned in this conversation has to wait for the user: it read the web (with a web tool, a shell command
 * that is not a local one, a skill pulled from a skills URL, or a slash command whose snippets reached outside or whose
 * skill came from the web), holds
 * text from outside (an imported transcript, an issue or pull request), used the browser or Vector Cloud, ran an MCP
 * tool or an MCP server's prompt, or took a subagent's report. Memory poisoning works by planting text the agent later
 * saves as its own, so once outside content is in the history, every write is held for review. A research session is
 * held as web throughout, and a subagent that read the web or ran an MCP tool passes that up: its parent is held as web
 * or mcp, not subagent.
 */
export function taint(messages: readonly SessionV1.WithParts[]): BrainSchema.Hold | undefined {
  const calls = messages.flatMap((message) => message.parts.flatMap((part) => (part.type === "tool" ? [part] : [])))
  const tools = calls.map((part) => part.tool)
  const commands = messages.flatMap((message) => message.parts.flatMap((part) => command(part)?.outside ?? []))
  if (tools.some((tool) => WEB_TOOLS.has(tool))) return "web"
  if (messages.some((message) => WEB_AGENTS.has(message.info.agent))) return "web"
  if (calls.some((part) => part.state.status !== "pending" && part.state.metadata?.[HOLD] === "web")) return "web"
  // A local file an editor embedded is this computer's, like what the read tool returns, and what the user pasted they
  // chose to send; other outside text is not. A note from an agent that only ran an MCP tool is held as MCP (below).
  if (
    messages.some((message) =>
      message.parts.some(
        (part) =>
          part.type === "text" &&
          outside(part) &&
          part.metadata?.[BrainSchema.OUTSIDE] !== "file" &&
          part.metadata?.[BrainSchema.OUTSIDE] !== BrainSchema.PASTE &&
          !(part.metadata?.[BrainSchema.OUTSIDE] === "subagent" && part.metadata?.[HOLD] === "mcp"),
      ),
    )
  )
    return "web"
  if (
    calls.some(
      (part) => part.tool === "skill" && part.state.status === "completed" && part.state.metadata?.remote === true,
    )
  )
    return "web"
  if (
    commands.includes("web") ||
    calls.some(
      (part) =>
        part.tool === "bash" && typeof part.state.input.command === "string" && !local(part.state.input.command),
    )
  )
    return "web"
  // A subagent that ran an MCP tool passes that up, on its task call or on a note about it, and is not held as less.
  if (
    messages.some((message) =>
      message.parts.some((part) =>
        part.type === "tool"
          ? part.state.status !== "pending" && part.state.metadata?.[HOLD] === "mcp"
          : part.type === "text" && part.metadata?.[HOLD] === "mcp",
      ),
    )
  )
    return "mcp"
  // Direct MCP content keeps its stronger hold when the same history also contains delegation.
  // A connect call is a connected tool's report only with the built-in tool's metadata; any other is an outside tool.
  const connected = (part: (typeof calls)[number]) =>
    part.tool === "connect" &&
    part.state.status !== "pending" &&
    (part.state.metadata?.connect !== undefined ||
      ["review", "fix", "findings", "status", "cancel"].includes(part.state.metadata?.action))
  if (
    commands.includes("mcp") ||
    calls.some((part) => !LOCAL_TOOLS.has(part.tool) && !DELEGATION_TOOLS.has(part.tool) && !connected(part))
  )
    return "mcp"
  // A background subagent's report, note up, waiting or interruption arrives as a synthetic note in a user message. A
  // background command's exit note adds nothing, like a foreground command's result.
  if (
    tools.some((tool) => DELEGATION_TOOLS.has(tool)) ||
    calls.some(connected) ||
    messages.some((message) =>
      message.parts.some(
        (part) => part.type === "text" && SUBAGENT_NOTES.some((key) => part.metadata?.[key] !== undefined),
      ),
    )
  )
    return "subagent"
  return undefined
}

/**
 * Whether a file is one Vector's memory is read from: a repository's .vector/RULES.md, .vector/BRAIN.md or BRAIN.md, or
 * the user's own RULES.md and MEMORY.md. Both the name a tool was given and the file it lands on count, so a link to
 * one is one too.
 */
export function source(file: string, personal: { readonly memory: string; readonly rules: string }) {
  const own = [personal.memory, personal.rules].map((item) => FSUtil.realpath(item))
  return [file, FSUtil.realpath(file)].some(
    (item) =>
      /(?:^|\/)(?:\.vector\/(?:rules|brain)|brain)\.md$/i.test(item.split(path.sep).join("/")) || own.includes(item),
  )
}

/** When the request message this step answers was sent: the per-message write cap counts from here. */
export function since(messages: readonly SessionV1.WithParts[]) {
  return messages.findLast((message) => message.info.role === "user" && asked(message))?.info.time.created ?? 0
}

/**
 * Whether a shell command's output comes from this computer (LocalCommand.local): its files, the repository's own
 * history, and the checks and scripts it runs. What is not known to be local counts as outside content.
 */
export const local = LocalCommand.local
