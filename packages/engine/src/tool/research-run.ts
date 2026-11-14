export * as ResearchRun from "./research-run"

import { readFile } from "node:fs/promises"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { httpClient } from "@vectordevai/core/effect/app-node-platform"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { BrainPrivate } from "@vectordevai/core/brain/private"
import { BrainSchema } from "@vectordevai/core/brain/schema"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { Global } from "@vectordevai/core/global"
import { EgressHttpClient } from "@vectordevai/core/local-mode/http-client"
import { ResearchNetwork } from "@vectordevai/core/research/network"
import { ResearchOutbound } from "@vectordevai/core/research/outbound"
import { ResearchPlan } from "@vectordevai/core/research/plan"
import { ResearchProvenance } from "@vectordevai/core/research/provenance"
import { ResearchRate } from "@vectordevai/core/research/rate"
import { ResearchReader } from "@vectordevai/core/research/reader"
import { ResearchRobots } from "@vectordevai/core/research/robots"
import { ResearchStore } from "@vectordevai/core/research/store"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { Location } from "@vectordevai/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@vectordevai/core/location-services"
import { Reference } from "@vectordevai/core/reference"
import { AbsolutePath } from "@vectordevai/core/schema"
import { Research } from "@vectordevai/schema/research"
import type { RunBudget } from "@vectordevai/schema/run-budget"
import { Context, Effect, Layer, Option, Schema, Scope, Semaphore } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { MCP } from "@/mcp"
import { Session } from "@/session/session"
import { TaskLimits } from "@/task/limits"
import { Instruction } from "../session/instruction"
import { SessionMemory } from "../session/memory"
import { SessionID } from "../session/schema"
import { SubagentLifecycle } from "./subagent-lifecycle"
import type { Tool } from "./tool"

// The engine's side of a Deep research run (sections 5.4 and 5.6a). A run is keyed by its lead's session and the
// repository's brain, so the researchers the lead launches write into the lead's run. What the run may read and what
// it may send are worked out here from the history of every session in the run, so they hold across restarts and are
// the same in every research tool:
// - the run is the newest plan the lead's session approved (research_plan's completed call carries its id);
// - provenance is the run's search results, the links research_read offered, and addresses the user typed;
// - the outbound check's private context is everything any agent of the run took in that is not known to be public:
//   the memory lines recalled, found or pinned for it whatever their scope (a researcher's how-you-work lines
//   included), MEMORY.md, the document titles and cards it was shown, every tool's output but the web's (files read,
//   commands run, a subagent's report, an MCP server's answer), files attached to a message, pages read in the user's
//   signed-in browser, pages read or fetched from the user's own network, and what the system prompts carry beside
//   the brain's digest (instruction files, agents' prompts set in config, references, MCP servers' instructions).
//   Only the root user's typed words are exempt: a sub-question, a task brief or a message to a task is written by an
//   agent.

export const LEAD = "research"
export const RESEARCHER = "researcher"
export const JUDGE = "research-judge"

/** research_plan's metadata key for the run it approved. */
export const RUN = "runID"

/** Where `vector run --research` puts its own choices for the run (search and scope): a text part's metadata. */
export const OPTIONS = "vector.research"

/** The task call's context key the judge gate sets: the research judge starts only from Vector's own gate. */
export const GATE = "researchJudgeGate"

/** Caps for one run: its spend and steps, the pages and searches the store counts, and its researchers. */
export type Limits = ResearchPlan.Limits

/** Default caps for one run, used only when the user has no cap of their own (section 11.2). */
export const LIMITS = ResearchPlan.LIMITS

/** What a researcher hands back to the lead, at most (section 5.3). */
export const RETURN_CHARS = 1_500

export const NO_PLAN = ResearchPlan.NO_PLAN
export const STOPPED = ResearchPlan.STOPPED
export const READ_APPROVAL = ResearchPlan.READ_APPROVAL
export const REQUEST_REFUSAL =
  "That research request would send text from what this session read. Rephrase the question with public terms, or ask the user to type the words they want researched."
export const BRIEF_REFUSAL =
  "That brief would send text from your private context to a web worker. Write the sub-question in public terms."
export const LEAD_ONLY =
  "A researcher takes its sub-question and any message from the research lead that launched it alone."
export const WARNED =
  "Run Guard warned that this run is close to its cap, so no new researcher starts. Write the report from what the run has, or resume a researcher with task_id."

export const OFFLINE = ResearchPlan.OFFLINE
export const OFFLINE_RESEARCHERS =
  "Vector Local's Web access is None, so research has no web workers. Answer the sub-question from this repository's brain and files yourself."

/** The research tools that reach the web, which research is not offered while Vector Local's Web access is None. */
export const NETWORK_TOOLS: readonly string[] = ResearchPlan.NETWORK_TOOLS

/**
 * Whether Vector Local is on with Web access None (section 5.9). Research then uses the brain and the repository's
 * files only: its plan's scope is the brain whatever was proposed, its network tools are not offered, and the lead
 * launches no researchers, whose work is the web.
 */
export const offline = ResearchPlan.offline

/** Whether a research tool is kept from research agents now: a network tool while Web access is None. */
export function withheld(tool: string) {
  return NETWORK_TOOLS.includes(tool) && offline()
}

// How long a run keeps its own rate limiter after its last read, and how many runs keep one.
const LIMITERS = 16
// How deep a session tree is walked: to the session the user types in, and down through subagents.
const DEPTH = 4

/** The network research reads through, shared with the V2 runner's research tools. */
export type Network = ResearchNetwork.Network
export const NetworkService = ResearchNetwork.Service
export const networkNode = ResearchNetwork.node

/** The run a research tool call works in. */
export type Found = {
  readonly place: Brain.Place
  /** The run's lead: the session that approved the plan. */
  readonly lead: Session.Info
  readonly run: Research.Run
  readonly plan: Research.Plan
  readonly detail: ResearchStore.Detail
  /** The user approved the plan on its card; otherwise it was approved on its own (a child or a headless run). */
  readonly approvedByUser: boolean
}

/** The run a call works in, or why there is none. */
export type Current = Found | { readonly refused: string }

export type Brief =
  | {
      readonly type: "ok"
      readonly prompt: string
      readonly budget?: RunBudget.Info
      /** A lead's subagent slots held for its researchers, so they start without waiting (multi-agent 5.B.5). */
      readonly reserve?: number
    }
  | { readonly type: "refused"; readonly message: string }

/** The sites the user chose for research: what may become a site: filter, and what reads as "You trust this site". */
export type Domains = { readonly prefer: readonly string[]; readonly avoid: readonly string[] }

export interface Interface {
  readonly place: () => Effect.Effect<Brain.Place>
  /** The run's lead: the session itself, or for a researcher or the judge the lead that launched it. */
  readonly lead: (sessionID: SessionID) => Effect.Effect<Session.Info>
  /** The run this call works in, or why there is none to work in. */
  readonly current: (ctx: Tool.Context) => Effect.Effect<Current>
  /** The outbound check's context: the run's, or without a run the whole session tree's the caller is in. */
  readonly context: (ctx: Tool.Context, found?: Found) => Effect.Effect<ResearchOutbound.Context>
  /**
   * The sites the user chose: their own config's and their company's, and the plan's when they approved it on its
   * card. A repository's avoid list and a plan an agent approved on its own choose nothing.
   */
  readonly domains: (found?: Found) => Effect.Effect<Domains>
  /** The addresses the run may read. */
  readonly provenance: (ctx: Tool.Context, found: Found) => Effect.Effect<ResearchProvenance.Addresses>
  /** Asks once per run before its first page is read. The approval is never saved. */
  readonly approve: (ctx: Tool.Context, found: Found, url: string) => Effect.Effect<void>
  readonly limiter: (runID: string) => ResearchRate.Limiter
  readonly robots: () => Effect.Effect<ResearchRobots.Cache | undefined>
  readonly network: Network
  /** The run's page and search budget, from the user's config or the defaults for its depth. */
  readonly limits: (depth: Research.Depth) => Effect.Effect<Limits>
  /**
   * A task brief for a research agent, before the child starts: the lead's request or a researcher's sub-question,
   * checked against what the caller may not send, and a researcher's brief cut to the sub-question and the run's
   * public preferences. A new researcher takes one of the run's researcher slots, held until the scope (the task
   * call) closes.
   */
  readonly brief: (input: {
    readonly agent: string
    readonly ctx: Tool.Context
    readonly prompt: string
    /** The rest of the brief the caller wrote (success criteria, a context pack), checked with the prompt. */
    readonly extra: readonly string[]
    readonly resume?: string
    /** The entry of a task batch this brief is. */
    readonly index?: number
  }) => Effect.Effect<Brief, never, Scope.Scope>
  /** What a researcher returns to the lead: at most 1,500 characters, and the notes it saved. */
  readonly returned: (sessionID: SessionID, text: string) => Effect.Effect<string>
  /**
   * A message an agent sends to a running task (task_manage), before it is delivered. A researcher hears from the
   * lead that launched it alone, and a message to a research lead or a researcher passes the check its brief passed.
   */
  readonly message: (input: {
    readonly ctx: Tool.Context
    readonly taskID: string
    readonly text: string
  }) => Effect.Effect<{ readonly type: "ok" } | { readonly type: "refused"; readonly message: string }>
}

export class Service extends Context.Service<Service, Interface>()("@vector/ResearchRun") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const brain = yield* Brain.Service
    const knowledge = yield* BrainKnowledge.Service
    const instruction = yield* Instruction.Service
    const store = yield* ResearchStore.Service
    const guests = yield* FreeModelGuests.Service
    const config = yield* Config.Service
    const guard = yield* SpendGuard.Service
    // robots.txt is read for research, so its requests are research-reader's wherever the check runs.
    const http = HttpClient.transform(
      EgressHttpClient.make(yield* HttpClient.HttpClient),
      EgressHttpClient.labelled("research-reader"),
    )
    const network = yield* NetworkService
    const locations = yield* LocationServiceMap.Service
    const mcp = yield* MCP.Service

    // Runs whose user approved reading public pages, in this process. A restart asks once more.
    const approved = new Set<string>()
    const approving = new Map<string, Semaphore.Semaphore>()
    const limiters = new Map<string, ResearchRate.Limiter>()
    const cached: { robots?: ResearchRobots.Cache } = {}
    // Researchers each run is starting, by the task call and entry that start them, counted with the run's children
    // until the call ends: the entries of one batch, and task calls made in one step, would otherwise all see the
    // same count and start past the cap together. One lock covers counting and reserving.
    const starting = new Map<string, Set<string>>()
    const slots = Semaphore.makeUnsafe(1)
    // The text of a run's pages, kept while its count of readable sources is the same.
    const pages = new Map<
      string,
      {
        readonly count: number
        readonly text: { readonly open: readonly string[]; readonly closed: readonly string[] }
      }
    >()

    const place = () => instruction.place()

    const lead = Effect.fn("ResearchRun.lead")(function* (sessionID: SessionID) {
      const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
      const agent = SubagentLifecycle.read(session)?.agent ?? session.agent
      if (session.parentID && (agent === RESEARCHER || agent === JUDGE))
        return yield* sessions.get(session.parentID).pipe(Effect.orDie)
      return session
    })

    // The session the user types in: the run's lead in Deep research, or the build session that handed it a question.
    const top = (sessionID: SessionID, depth = 0): Effect.Effect<Session.Info> =>
      sessions.get(sessionID).pipe(
        Effect.orDie,
        Effect.flatMap((session) =>
          session.parentID && depth < DEPTH ? top(session.parentID, depth + 1) : Effect.succeed(session),
        ),
      )

    // A session's whole history. The calling session's messages are this step's, with the memory it was shown filled
    // in; the stored ones before a compaction still count, since what was read then may be in its summary.
    const history = Effect.fnUntraced(function* (ctx: Tool.Context, sessionID: SessionID) {
      const stored = yield* sessions
        .messages({ sessionID })
        .pipe(Effect.catch(() => Effect.succeed([] as SessionV1.WithParts[])))
      if (sessionID !== ctx.sessionID) return stored
      const live = new Map(ctx.messages.map((message) => [message.info.id, message]))
      const known = new Set(stored.map((message) => message.info.id))
      return [
        ...stored.map((message) => live.get(message.info.id) ?? message),
        ...ctx.messages.filter((message) => !known.has(message.info.id)),
      ]
    })

    // A session's history and every subagent's below it: a subagent's report, and what it says through task_manage,
    // may relay anything it took in.
    const lineage = (ctx: Tool.Context, sessionID: SessionID, depth = 0): Effect.Effect<SessionV1.WithParts[][]> =>
      Effect.gen(function* () {
        const own = yield* history(ctx, sessionID)
        if (depth >= DEPTH) return [own]
        const below = yield* Effect.forEach(yield* sessions.children(sessionID), (child) =>
          lineage(ctx, child.id, depth + 1),
        )
        return [own, ...below.flat()]
      })

    // Every session of the run: the lead and the research agents it launched. Provenance comes from these alone.
    const members = Effect.fn("ResearchRun.members")(function* (ctx: Tool.Context, leader: Session.Info) {
      const children = (yield* sessions.children(leader.id)).filter((child) => {
        const agent = SubagentLifecycle.read(child)?.agent ?? child.agent
        return agent === RESEARCHER || agent === JUDGE
      })
      return yield* Effect.forEach([leader.id, ...children.map((child) => child.id)], (id) => history(ctx, id))
    })

    // What the root user sent themselves: an address or a question they pasted is theirs as much as one they typed.
    const saidOf = Effect.fn("ResearchRun.said")(function* (ctx: Tool.Context) {
      const root = yield* top(ctx.sessionID)
      const messages = yield* history(ctx, root.id)
      return messages.flatMap((message) =>
        message.info.role === "user" ? [SessionMemory.said(message)].filter(Boolean) : [],
      )
    })

    const current = Effect.fn("ResearchRun.current")(function* (ctx: Tool.Context) {
      const where = yield* place()
      const leader = yield* lead(ctx.sessionID)
      const messages = yield* history(ctx, leader.id)
      // The newest plan call decides: one the user has not approved yet (a steer, a cancel) leaves nothing to work in.
      const planned = messages
        .flatMap((message) => message.parts)
        .findLast(
          (part): part is SessionV1.ToolPart =>
            part.type === "tool" && part.tool === "research_plan" && part.state.status === "completed",
        )
      const runID =
        planned?.state.status === "completed" && typeof planned.state.metadata[RUN] === "string"
          ? planned.state.metadata[RUN]
          : undefined
      if (!runID) return refuse(NO_PLAN)
      const detail = yield* store.get(where, runID)
      if (!detail) return refuse(ResearchStore.NO_RUN)
      if (detail.run.status === "stopped" || detail.run.status === "failed") return refuse(STOPPED)
      // A session an invited guest has acted in keeps nothing of its research in the brain.
      if (!detail.guest && ((yield* guests.marked(leader.id)) || (yield* guests.marked(ctx.sessionID))))
        yield* store.guest(where, runID)
      const plan = detail.run.plan
      if (!plan) return refuse(NO_PLAN)
      // Approved on its own unless the user answered the card; a status-only call keeps the earlier approval.
      const answers = messages
        .flatMap((message) => message.parts)
        .flatMap((part) =>
          part.type === "tool" &&
          part.tool === "research_plan" &&
          part.state.status === "completed" &&
          part.state.metadata[RUN] === runID
            ? [part.state.metadata.answer]
            : [],
        )
      const approvedByUser = answers.some((answer) => answer === "start" || answer === "start-deep")
      return { place: where, lead: leader, run: detail.run, plan, detail, approvedByUser } satisfies Found as Current
    })

    const context = Effect.fn("ResearchRun.context")(function* (ctx: Tool.Context, found?: Found) {
      const where = found?.place ?? (yield* place())
      const root = yield* top(ctx.sessionID)
      // Everything in a session tree counts, since a subagent's report or message may relay what it took in: without a
      // run (the build agent's research request, or a message to a research agent) the tree the caller is in; in a run
      // the lead's session and every subagent below it, the run's researchers and judge, and the subagents build ran
      // in a session that changed to Deep research. Stored history counts too: what was read before a compaction may
      // be in the summary.
      const messages = (yield* lineage(ctx, found ? found.lead.id : root.id)).flat()
      const parts = messages.flatMap((message) => message.parts)
      const saved = new Set(parts.flatMap(savedPrivately))
      const taken = messages.map((message) => intake(message, saved))
      const guest = (yield* guests.marked(root.id)) || (yield* guests.marked(ctx.sessionID))

      // The memory entries the run was shown, whatever their scope: recalled into a message, found by the memory tool
      // (whose transcript keeps a personal or private entry's id alone), or pinned in a digest, which carries every
      // pinned entry the role may hear. How the owner works and what the repository learned are the work; the owner's
      // decisions, lessons and facts, the repository's facts, and whatever was learned beside a private document are
      // private. A session an invited guest is in was shown none of the owner's own.
      const shown = new Set(
        parts.flatMap((part) => [...(SessionMemory.recall(part)?.ids ?? []), ...SessionMemory.personal(part)]),
      )
      const entries = (yield* brain.list(where, {})).filter(
        (entry) =>
          (shown.has(entry.id) || entry.pinned) && (!guest || (entry.scope === "repository" && !entry.private)),
      )
      const work = (entry: (typeof entries)[number]) =>
        !entry.private &&
        (entry.scope === "repository" ? entry.kind !== "fact" : entry.kind === "preference" || entry.kind === "review")
      const files = brain.files()
      const memory = guest ? "" : yield* text(files.memory)
      // The owner's rules and the repository's own rules files, which every digest carries.
      const rules = yield* Effect.forEach([files.rules, ...where.sources.map((source) => source.path)], text)
      // The digest names the repository's documents by title, a private document's to the owner.
      const titles = yield* knowledge.titles(where, { personal: !guest })
      // What the lead's and build's system prompts carry beside the digest: the instruction files, the agents' prompts
      // set in config, the references the environment names and MCP servers' instructions. The repository's are the
      // work; the user's own instruction files, and their own prompts for agents, are private.
      const carried = yield* instruction.contents().pipe(Effect.orDie)
      const own = (yield* config.getGlobal()).agent ?? {}
      const prompts = Object.entries((yield* config.get()).agent ?? {}).flatMap(([name, item]) =>
        item?.prompt ? [{ text: item.prompt, user: own[name]?.prompt === item.prompt }] : [],
      )
      const named = yield* references()
      const servers = yield* mcp.instructions()

      // Document cards and passages the run was shown, rendered again from their ids as each request renders them: a
      // private document's are private, the repository's the work.
      const cards = [
        ...new Set(
          parts.flatMap((part) => [
            ...(SessionMemory.recall(part)?.cards ?? []),
            ...(SessionMemory.knowledge(part)?.cards ?? []),
          ]),
        ),
      ]
      const gets = parts.flatMap((part) => SessionMemory.knowledge(part)?.get ?? [])
      const lines = cards.length
        ? yield* knowledge.lines(where, cards, { personal: !guest, sessionID: ctx.sessionID })
        : new Map<string, string>()
      const passages = yield* Effect.forEach(gets, (item) =>
        knowledge
          .get(where, { ...item, personal: !guest, sessionID: ctx.sessionID })
          .pipe(Effect.map((got) => ({ id: item.id, text: got?.text }))),
      )
      const shownCards = [
        ...[...lines].map(([id, line]) => ({ id, text: line })),
        ...passages.flatMap((item) => (item.text ? [{ id: item.id, text: item.text }] : [])),
      ]
      const visible = yield* Effect.forEach(shownCards, (item) =>
        knowledge.sources(where, [item.id]).pipe(
          Effect.map((found) => ({
            ...item,
            private:
              found.documents.length === 0 || found.documents.some((document) => document.visibility === "private"),
          })),
        ),
      )
      const card = (secret: boolean) => visible.flatMap((item) => (item.private === secret ? [item.text] : []))

      const sources = found ? yield* sourceText(found) : { open: [] as string[], closed: [] as string[] }
      const results = parts.flatMap((part) => resultsOf(part, found?.run.id))
      const chosen = yield* domains(found)
      return {
        private: [
          memory,
          ...entries.filter((entry) => !work(entry)).map((entry) => entry.text),
          ...titles.flatMap((item) => (item.visibility === "private" ? [item.title] : [])),
          ...card(true),
          ...taken.flatMap((item) => item.private),
          ...sources.closed,
          ...carried.private,
          ...prompts.flatMap((item) => (item.user ? [item.text] : [])),
        ].filter(Boolean),
        work: [
          ...rules,
          // The lead's and build's system prompts name the working tree, and its path names the user and the
          // repository. A researcher's and the judge's do not.
          where.root,
          ...entries.filter(work).map((entry) => entry.text),
          ...titles.flatMap((item) => (item.visibility === "private" ? [] : [item.title])),
          ...card(false),
          ...taken.flatMap((item) => item.work),
          ...carried.work,
          ...prompts.flatMap((item) => (item.user ? [] : [item.text])),
          ...named.flatMap((reference) => [reference.name, reference.path, reference.description ?? ""]),
          ...servers.map((server) => server.instructions),
        ].filter(Boolean),
        // The home folder and the working tree: local paths are read for the user names in them, and a query may not
        // name the working tree whole.
        home: [Global.Path.home, where.root],
        typed: yield* saidOf(ctx),
        public: [...results.flatMap((result) => [result.title, result.snippet]), ...sources.open],
        results: results.map((result) => result.url),
        // The user's own sites become site: filters: the ones they chose, and the sites their own preferences about
        // sources name (section 6.4a), of those the run was shown and that pass the outward screen, read as the check
        // reads tokens. Only public host names among them exempt anything.
        domains: [
          ...chosen.prefer,
          ...chosen.avoid,
          ...entries
            .filter(
              (entry) =>
                entry.scope === "personal" &&
                entry.kind === "preference" &&
                entry.facet === "sources" &&
                BrainPrivate.screened({ kind: entry.kind, text: entry.text, private: entry.private }),
            )
            .flatMap((entry) => ResearchOutbound.rare(entry.text)),
        ],
      } satisfies ResearchOutbound.Context
    })

    // The references the environment block names: each one's name, path and description.
    const references = Effect.fn("ResearchRun.references")(function* () {
      const ctx = yield* InstanceState.context
      return yield* Effect.gen(function* () {
        const service = yield* Reference.Service
        return (yield* service.list()).filter((reference) => reference.description !== undefined)
      }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
    })

    const domains = Effect.fn("ResearchRun.domains")(function* (found?: Found) {
      const own = yield* config.researchDomains()
      const avoided = new Set(own.avoid.map(normal))
      // A plan's sites count only when the user approved it on its card: an agent that approved its own plan could
      // otherwise choose any site. Every plan carries the merged config's avoid list, a repository's included, so a
      // site only a repository avoids is left out of it here.
      const repository = new Set(
        ((yield* config.get()).research?.domains?.avoid ?? []).map(normal).filter((domain) => !avoided.has(domain)),
      )
      const plan = found?.approvedByUser ? found.plan : undefined
      return {
        prefer: [...new Set([...own.prefer, ...(plan?.prefer_domains ?? [])].map(normal))].filter(Boolean),
        avoid: [
          ...new Set([
            ...avoided,
            ...(plan?.avoid_domains ?? []).map(normal).filter((domain) => !repository.has(domain)),
          ]),
        ].filter(Boolean),
      } satisfies Domains
    })

    // The text of the run's pages: what was read on the user's own network is private, the rest public.
    const sourceText = Effect.fn("ResearchRun.sourceText")(function* (found: Found) {
      const readable = found.detail.sources.filter(
        (source) => (source.status === "read" || source.status === "paywalled") && !source.forgotten,
      )
      const known = pages.get(found.run.id)
      if (known && known.count === readable.length) return known.text
      const saved = yield* Effect.forEach(readable, (source) => store.source(found.place, found.run.id, source.id))
      const text = {
        open: saved.flatMap((item) => (item && !item.private ? item.chunks.map((chunk) => chunk.text) : [])),
        closed: saved.flatMap((item) => (item?.private ? item.chunks.map((chunk) => chunk.text) : [])),
      }
      pages.set(found.run.id, { count: readable.length, text })
      if (pages.size > LIMITERS) pages.delete(pages.keys().next().value!)
      return text
    })

    const provenance = Effect.fn("ResearchRun.provenance")(function* (ctx: Tool.Context, found: Found) {
      const parts = (yield* members(ctx, found.lead)).flat().flatMap((message) => message.parts)
      const typed = (yield* saidOf(ctx)).flatMap(ResearchProvenance.typed)
      const results = parts.flatMap((part) => resultsOf(part, found.run.id).map((result) => result.url))
      const links = parts.flatMap((part) => linksOf(part, found.run.id))
      return ResearchProvenance.add(
        ResearchProvenance.add(ResearchProvenance.add(ResearchProvenance.empty(), results, "search"), links, "link"),
        typed,
        "typed",
      )
    })

    const approve = Effect.fn("ResearchRun.approve")(function* (ctx: Tool.Context, found: Found, url: string) {
      if (approved.has(found.run.id)) return
      const lock = approving.get(found.run.id) ?? Semaphore.makeUnsafe(1)
      approving.set(found.run.id, lock)
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (approved.has(found.run.id)) return
          // Scoped to the run and never saved: there is nothing for "Always" to keep.
          yield* ctx.ask({
            permission: "research_read",
            patterns: [found.run.id],
            always: [],
            metadata: { runID: found.run.id, url, question: found.plan.question, description: READ_APPROVAL },
          })
          approved.add(found.run.id)
        }),
      )
      approving.delete(found.run.id)
    })

    const limiter = (runID: string) => {
      const known = limiters.get(runID)
      limiters.delete(runID)
      const next = known ?? ResearchRate.make()
      limiters.set(runID, next)
      if (limiters.size > LIMITERS) limiters.delete(limiters.keys().next().value!)
      return next
    }

    const robots = Effect.fn("ResearchRun.robots")(function* () {
      if ((yield* config.get()).research?.robots === false) return undefined
      cached.robots ??= ResearchReader.robots({ http, resolver: network.resolver, publicNames: network.publicNames })
      return cached.robots
    })

    const limits = Effect.fn("ResearchRun.limits")(function* (depth: Research.Depth) {
      const own = (yield* config.get()).research?.limits?.[depth]
      return { ...LIMITS[depth], ...own } satisfies Limits
    })

    // The researchers a run may have: its depth's cap, held to the slots its lead can reserve for them beside its own in
    // the conversation (5.B.5), so each one starts on a reserved slot and none is refused for want of one.
    const researchers = Effect.fn("ResearchRun.researchers")(function* (depth: Research.Depth, sessionID: SessionID) {
      const root = yield* top(sessionID)
      const running = TaskLimits.resolve(yield* config.get(), yield* guests.marked(root.id)).running
      return Math.max(0, Math.min((yield* limits(depth)).researchers, running - 1))
    })

    const brief = Effect.fn("ResearchRun.brief")(function* (input: {
      readonly agent: string
      readonly ctx: Tool.Context
      readonly prompt: string
      readonly extra: readonly string[]
      readonly resume?: string
      readonly index?: number
    }) {
      const text = [input.prompt, ...input.extra].join("\n")
      if (input.agent === LEAD) {
        // The lead starts with only what this request says, so the request must not carry private text with it.
        const checked = ResearchOutbound.check(text, yield* context(input.ctx))
        if (!checked.ok) return { type: "refused", message: refusal(REQUEST_REFUSAL, checked) } satisfies Brief
        // The lead stays at its launcher's size: a deep run (and its default caps) only from a Thorough request.
        const size = input.ctx.extra?.taskSize
        const depth: Research.Depth =
          size && typeof size === "object" && "tier" in size && size.tier === "thorough" ? "deep" : "focused"
        const own = (yield* guard.snapshot(input.ctx.sessionID))?.budget
        const caps = yield* limits(depth)
        // As many slots as the run may have researchers; none where it can launch none (offline, or "no subagents").
        const capped = size && typeof size === "object" && "capped" in size && size.capped === true
        const reserve = capped || offline() ? 0 : yield* researchers(depth, input.ctx.sessionID)
        return {
          type: "ok",
          prompt: input.prompt,
          // Research's default caps apply only when the user set none of their own.
          ...(own?.usd === undefined && own?.steps === undefined
            ? { budget: { usd: caps.usd, steps: caps.steps } }
            : {}),
          ...(reserve > 0 ? { reserve } : {}),
        } satisfies Brief
      }
      if (input.agent !== RESEARCHER) return { type: "ok", prompt: input.prompt } satisfies Brief
      if (input.ctx.agent !== LEAD)
        return {
          type: "refused",
          message: "Only the research lead launches researchers, inside its run.",
        } satisfies Brief
      if (offline()) return { type: "refused", message: OFFLINE_RESEARCHERS } satisfies Brief
      const found = yield* current(input.ctx)
      if ("refused" in found) return { type: "refused", message: found.refused } satisfies Brief
      if (!input.resume) {
        // One Run Guard run covers the lineage (section 11.2), so a research lead the build agent started counts the
        // build run's spend, and its own task budget too: once either warns, no new researcher starts.
        if (yield* warned(input.ctx.sessionID)) return { type: "refused", message: WARNED } satisfies Brief
        const cap = yield* researchers(found.plan.depth, found.lead.id)
        // The task call and entry that start this researcher, as its child's record will name them.
        const key = `${input.ctx.sessionID}:${input.ctx.callID ?? input.ctx.messageID}:${input.index ?? 0}`
        const reserved = yield* slots.withPermits(1)(
          Effect.gen(function* () {
            // This run's researchers: a session may hold several runs, one after another.
            const children = (yield* sessions.children(found.lead.id)).filter(
              (child) =>
                (SubagentLifecycle.read(child)?.agent ?? child.agent) === RESEARCHER &&
                child.time.created >= found.run.created_at,
            )
            const started = new Set(
              children.map((child) => {
                const record = SubagentLifecycle.read(child)
                return record ? `${record.batchID}:${record.batchIndex ?? 0}` : child.id
              }),
            )
            const pending = starting.get(found.run.id) ?? new Set<string>()
            if (children.length + [...pending].filter((item) => !started.has(item)).length >= cap) return false
            starting.set(found.run.id, pending.add(key))
            return true
          }),
        )
        if (!reserved)
          return {
            type: "refused",
            message: `This ${found.plan.depth} research has its ${cap} researcher${cap === 1 ? "" : "s"}. Research the rest yourself, or resume one with task_id.`,
          } satisfies Brief
        // Held until the task call ends: by then its child exists and counts itself, or it never started.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            const pending = starting.get(found.run.id)
            pending?.delete(key)
            if (pending?.size === 0) starting.delete(found.run.id)
          }),
        )
      }
      const run = yield* context(input.ctx, found)
      const checked = ResearchOutbound.check(text, run)
      if (!checked.ok) return { type: "refused", message: refusal(BRIEF_REFUSAL, checked) } satisfies Brief
      // A researcher gets its sub-question and the run's public preferences, nothing else of the lead's context. The
      // plan's own words came from the lead too, so they go only when they pass the same check.
      const open = (value: string | undefined) => (value && ResearchOutbound.check(value, run).ok ? value : undefined)
      const question = open(found.plan.question)
      const period = open(found.plan.time_window)
      const prefer = (found.plan.prefer_domains ?? []).filter((domain) => open(domain))
      const avoid = (found.plan.avoid_domains ?? []).filter((domain) => open(domain))
      return {
        type: "ok",
        prompt: [
          "<research_assignment>",
          ...(question ? [`Research question: ${question}`] : []),
          `Your sub-question: ${input.prompt.trim()}`,
          ...(prefer.length ? [`Prefer sources on: ${prefer.join(", ")}`] : []),
          ...(avoid.length ? [`Avoid sources on: ${avoid.join(", ")}`] : []),
          ...(period ? [`Time window: ${period}`] : []),
          `Save what you find with research_note, then return at most ${RETURN_CHARS} characters with the note IDs you saved.`,
          "</research_assignment>",
        ].join("\n"),
      } satisfies Brief
    })

    // Whether Run Guard warned the run this session spends in: its lineage's run, or a task budget it runs under.
    const warned = Effect.fn("ResearchRun.warned")(function* (sessionID: SessionID) {
      if ((yield* guard.snapshot(sessionID))?.warned) return true
      return (yield* guard.scopes(sessionID)).some(
        (scope) =>
          scope.budget.usd !== undefined &&
          scope.spentUsd >= scope.budget.usd * (scope.budget.warnAt ?? SpendGuard.WARN_AT),
      )
    })

    const returned = Effect.fn("ResearchRun.returned")(function* (sessionID: SessionID, text: string) {
      const notes = (yield* sessions
        .messages({ sessionID })
        .pipe(Effect.catch(() => Effect.succeed([] as SessionV1.WithParts[]))))
        .flatMap((message) => message.parts)
        .flatMap((part) =>
          part.type === "tool" &&
          part.tool === "research_note" &&
          part.state.status === "completed" &&
          typeof part.state.metadata?.note === "string"
            ? [part.state.metadata.note as string]
            : [],
        )
      const trimmed = text.trim()
      const clipped = trimmed.length > RETURN_CHARS ? `${trimmed.slice(0, RETURN_CHARS - 1).trimEnd()}…` : trimmed
      return notes.length ? `${clipped}\n\nNotes saved: ${[...new Set(notes)].join(", ")}` : clipped
    })

    const message = Effect.fn("ResearchRun.message")(function* (input: {
      readonly ctx: Tool.Context
      readonly taskID: string
      readonly text: string
    }) {
      const id = Schema.decodeUnknownOption(SessionID)(input.taskID)
      if (Option.isNone(id)) return { type: "ok" as const }
      const task = yield* sessions.get(id.value).pipe(Effect.option)
      if (Option.isNone(task)) return { type: "ok" as const }
      const agent = SubagentLifecycle.read(task.value)?.agent ?? task.value.agent
      if (agent === LEAD) {
        // The lead works from its request and what it is told, so a message must not carry private text either.
        const checked = ResearchOutbound.check(input.text, yield* context(input.ctx))
        return checked.ok
          ? { type: "ok" as const }
          : { type: "refused" as const, message: refusal(REQUEST_REFUSAL, checked) }
      }
      if (agent !== RESEARCHER && agent !== JUDGE) return { type: "ok" as const }
      if (input.ctx.agent !== LEAD || task.value.parentID !== input.ctx.sessionID)
        return { type: "refused" as const, message: LEAD_ONLY }
      const found = yield* current(input.ctx)
      if ("refused" in found) return { type: "refused" as const, message: found.refused }
      const checked = ResearchOutbound.check(input.text, yield* context(input.ctx, found))
      return checked.ok
        ? { type: "ok" as const }
        : { type: "refused" as const, message: refusal(BRIEF_REFUSAL, checked) }
    })

    return Service.of({
      place,
      lead,
      current,
      context,
      domains,
      message,
      provenance,
      approve,
      limiter,
      robots,
      network,
      limits,
      brief,
      returned,
    })
  }),
)

const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Session.node,
    Brain.node,
    BrainKnowledge.node,
    Instruction.node,
    ResearchStore.node,
    FreeModelGuests.node,
    Config.node,
    SpendGuard.node,
    httpClient,
    networkNode,
    locationServiceMapNode,
    MCP.node,
  ],
})

/** A search result research_search recorded for a run. */
export type Result = { readonly url: string; readonly title: string; readonly snippet: string }

/** The search results a research_search call of this run recorded. */
export function resultsOf(part: SessionV1.Part, runID: string | undefined): Result[] {
  if (part.type !== "tool" || part.tool !== "research_search" || part.state.status !== "completed") return []
  if (runID !== undefined && part.state.metadata?.[RUN] !== runID) return []
  const results = part.state.metadata?.results
  return Array.isArray(results)
    ? results.flatMap((item: unknown) =>
        item && typeof item === "object" && "url" in item && typeof item.url === "string"
          ? [
              {
                url: item.url,
                title: "title" in item && typeof item.title === "string" ? item.title : "",
                snippet: "snippet" in item && typeof item.snippet === "string" ? item.snippet : "",
              },
            ]
          : [],
      )
    : []
}

/** The links a research tool call of this run offered: research_read's, and the research browser's ("via S#"). */
export function linksOf(part: SessionV1.Part, runID: string): string[] {
  if (part.type !== "tool" || (part.tool !== "research_read" && part.tool !== "research_browser")) return []
  if (part.state.status !== "completed" || part.state.metadata?.[RUN] !== runID) return []
  const links = part.state.metadata?.links
  return Array.isArray(links) ? links.filter((link: unknown): link is string => typeof link === "string") : []
}

// Tools whose output is the web's. A public page and a search result are the run's public text, from the store and
// the search calls; a page read on the user's own network is private. research_plan, research_note and
// research_report hold what the run already read.
const WEB_TOOLS = new Set([
  "webfetch",
  "websearch",
  "research_plan",
  "research_search",
  "research_read",
  "research_browser",
  "research_note",
  "research_report",
])
// Tools whose output the repository or Vector wrote: the work. A subagent's report is the work too: what the subagent
// took in counts by its own kind, since the context reads every session below the caller.
const WORK_TOOLS = new Set([
  "bash",
  "read",
  "grep",
  "glob",
  "list",
  "lsp",
  "edit",
  "write",
  "apply_patch",
  "todowrite",
  "question",
  "skill",
  "escalate",
  "plan_exit",
  "invalid",
  "StructuredOutput",
  "task",
  "task_manage",
  "send_teammate_message",
  "research",
])

/**
 * What a message took in, by kind: everything but what is known to be public. A tool's output is private unless the
 * repository or Vector wrote it (the work) or the web did; so the memory tool's, the user's own signed-in browser's,
 * an MCP server's and a plugin's are private. A researcher's or the judge's report is the run's own and adds nothing.
 * In a user message a file attached and Vector's other notes are the work, and text from outside (an issue, an
 * imported transcript) is private, but for a local file an editor embedded. The user's typed words are exempt anyway.
 */
function intake(message: SessionV1.WithParts, saved: ReadonlySet<string>) {
  const found = message.parts.flatMap((part): { readonly kind: "private" | "work"; readonly text: string }[] => {
    if (part.type === "text" && message.info.role === "user") {
      if (SessionMemory.outside(part))
        return [{ kind: part.metadata?.[BrainSchema.OUTSIDE] === "file" ? "work" : "private", text: part.text }]
      return part.synthetic ? [{ kind: "work", text: part.text }] : []
    }
    if (part.type !== "tool" || part.state.status !== "completed") return []
    const text = part.state.output
    // A page read or fetched from the user's own computer or network is theirs.
    if ((part.tool === "research_read" || part.tool === "webfetch") && part.state.metadata?.private === true)
      return [{ kind: "private", text }]
    if (WEB_TOOLS.has(part.tool)) return []
    // Such a page saved whole when it was too long to show, read back.
    const input = part.state.input
    if (
      (part.tool === "read" || part.tool === "grep") &&
      [...saved].some((file) => input.filePath === file || input.path === file || text.includes(file))
    )
      return [{ kind: "private", text }]
    if (part.tool === "task" && runOwn(part.state.metadata)) return []
    return [{ kind: WORK_TOOLS.has(part.tool) ? "work" : "private", text }]
  })
  return {
    private: found.flatMap((item) => (item.kind === "private" ? [item.text] : [])),
    work: found.flatMap((item) => (item.kind === "work" ? [item.text] : [])),
  }
}

// Where webfetch saved a page from the user's own network that was too long to show.
function savedPrivately(part: SessionV1.Part) {
  if (part.type !== "tool" || part.tool !== "webfetch" || part.state.status !== "completed") return []
  const file = part.state.metadata?.outputPath
  return part.state.metadata?.private === true && typeof file === "string" ? [file] : []
}

// Whether a task call launched only the run's own research agents: a researcher or the judge.
function runOwn(metadata: Record<string, unknown> | undefined) {
  const agents = Array.isArray(metadata?.tasks)
    ? metadata.tasks.map((item: unknown) =>
        item && typeof item === "object" && "agent" in item ? item.agent : undefined,
      )
    : [metadata?.agent]
  return agents.length > 0 && agents.every((agent) => agent === RESEARCHER || agent === JUDGE)
}

function refuse(message: string): Current {
  return { refused: message }
}

function refusal(message: string, checked: Extract<ResearchOutbound.Result, { ok: false }>) {
  return checked.reason === "secret"
    ? `${message} It holds a password, key or token.`
    : `${message} It shares "${checked.match}".`
}

const normal = ResearchPlan.normal

// Node's API, since the desktop's engine runs on Node.
const text = (file: string) => Effect.promise(() => readFile(file, "utf8").catch(() => ""))
