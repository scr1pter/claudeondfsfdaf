import { Billing } from "@vectordevai/schema/billing"
import { Brain } from "@vectordevai/core/brain/brain"
import { Database } from "@vectordevai/core/database/database"
import { ResearchEstimate } from "@vectordevai/core/research/estimate"
import { ResearchPlan } from "@vectordevai/core/research/plan"
import { ResearchReader } from "@vectordevai/core/research/reader"
import { ResearchStore } from "@vectordevai/core/research/store"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { ModelSlots } from "@vectordevai/core/local-mode/model-slots"
import { freeModelMayTrain } from "@vectordevai/core/free-model-choice"
import { isFreeModel } from "@vectordevai/schema/free-model"
import { MemoryEvent } from "@vectordevai/schema/memory-event"
import { Research } from "@vectordevai/schema/research"
import type { TaskSize } from "@vectordevai/schema/task-size"
import { Cause, Effect, Option, Schema } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { Provider } from "@/provider/provider"
import { Question } from "../question"
import { MessageV2 } from "../session/message-v2"
import { MessageID, SessionID } from "../session/schema"
import type { TaskSizeContext } from "./escalate"
import { ResearchRun } from "./research-run"
import { ResearchBrowser } from "./research-browser"
import { options, searchProvider } from "./research-search"
import { SubagentLifecycle } from "./subagent-lifecycle"
import { Tool } from "./tool"
import DESCRIPTION from "./research-plan.txt"

// research_plan (section 5.4): proposes the plan, works out what it is likely to cost, and asks the user through the
// plan card (Start, Start deep or Cancel; a typed reply is a steer). The run starts in the store only once the plan is
// approved, so nothing is searched or read before. A call that only moves sub-questions along never asks again. In a
// child session (the build agent's research tool) and where no one can answer, the plan is approved on its own,
// within its launcher's size: only the user's own answer on the root plan card raises a run to Thorough (RC7). What the
// user ticks "Always" for on the card (the sites to prefer or avoid, the format) is kept as their preference, and every
// later plan carries it, marked as coming from their preferences.

export const Parameters = Schema.Struct({
  question: Schema.String.check(Schema.isLengthBetween(1, 1_000)).annotate({
    description: "The research question, restated in one or two sentences",
  }),
  subquestions: Schema.Array(Schema.String.check(Schema.isLengthBetween(1, 300)))
    .check(Schema.isLengthBetween(1, 8))
    .annotate({ description: "One to eight sub-questions that together answer the question" }),
  scope: Research.Scope.annotate({
    description: "web, web+brain (the web and this repository's brain), or brain (the brain and files only)",
  }),
  depth: Research.Depth.annotate({ description: "focused (one agent) or deep (researchers and a citation judge)" }),
  prefer_domains: Schema.optional(Schema.Array(Schema.String.check(Schema.isLengthBetween(1, 253)))).annotate({
    description: "Sites to prefer, such as nature.com",
  }),
  avoid_domains: Schema.optional(Schema.Array(Schema.String.check(Schema.isLengthBetween(1, 253)))).annotate({
    description: "Sites to avoid",
  }),
  format: Schema.optional(Research.Format).annotate({ description: "brief, report, table or memo" }),
  time_window: Schema.optional(Schema.String.check(Schema.isMaxLength(80))).annotate({
    description: "The period the sources should cover, such as 'since 2023'",
  }),
  status: Schema.optional(Schema.Array(Research.SubquestionStatus)).annotate({
    description:
      "Where each sub-question stands (open, answered, dropped), in order. A call that only changes this never asks the user",
  }),
})

type Learned = {
  readonly prefer_domains?: readonly string[]
  readonly avoid_domains?: readonly string[]
  readonly format?: Research.Format
}

type Metadata = {
  runID?: string
  plan?: Research.Plan
  approved?: boolean
  answer?: "start" | "start-deep" | "cancel" | "steer" | "automatic" | "status"
  estimate?: string
  always?: readonly string[]
  /** What of the plan came from the user's preferences, for the card to mark "from your preferences". */
  learned?: Learned
  /** An approved deep plan raises the request to Thorough, as escalate's result does; only the user's answer does. */
  from?: TaskSize.Tier
  to?: TaskSize.Tier
  source?: "user"
  /** While the plan card is open: what the app's card shows beside the plan, so each field can be edited. */
  card?: Card
}

/** What the plan card shows besides the proposed plan, on the running part while the user decides. */
export type Card = {
  /** Start deep is offered, with its own estimate. */
  readonly deep: boolean
  readonly deepEstimate?: string
  /** Where research searches: in each research agent's own browser, or nowhere here, with why. */
  readonly search: {
    readonly provider: "browser" | "none"
    readonly reason?: string
  }
  /**
   * The user's own sites, from their config and from what they ticked Always for on an earlier card, and the format
   * they keep: the card marks them "from your preferences".
   */
  readonly preferences: {
    readonly prefer: readonly string[]
    readonly avoid: readonly string[]
    readonly format?: Research.Format
  }
  /** Vector Local's Web access is None: the scope stays the brain and the repository's files. */
  readonly offline: boolean
}

const FROM_PREFERENCES = "from your preferences"
// A base prompt to estimate with before the session has measured one on this model.
const BASE_PROMPT = 12_000

export const ResearchPlanTool = Tool.define<
  typeof Parameters,
  Metadata,
  | ResearchRun.Service
  | ResearchStore.Service
  | Question.Service
  | Config.Service
  | RuntimeFlags.Service
  | SpendGuard.Service
  | FreeModelGuests.Service
  | Database.Service
  | Brain.Service
  | EventV2Bridge.Service
>(
  "research_plan",
  Effect.gen(function* () {
    const research = yield* ResearchRun.Service
    const store = yield* ResearchStore.Service
    const question = yield* Question.Service
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service
    const guard = yield* SpendGuard.Service
    const guests = yield* FreeModelGuests.Service
    const database = yield* Database.Service
    const brain = yield* Brain.Service
    const events = yield* EventV2Bridge.Service
    // Who can answer a plan card: the same clients the question tool is offered to.
    const interactive = ["app", "cli", "desktop"].includes(flags.client) || flags.enableQuestionTool

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const lead = yield* research.lead(SessionID.make(ctx.sessionID))
          if (lead.id !== ctx.sessionID)
            return { title: "Not planned", output: "Only the research lead plans a run.", metadata: {} }
          const place = yield* research.place()
          const cfg = yield* config.get()
          const size = ctx.extra?.taskSize as TaskSizeContext | undefined
          // What `vector run --research` was told: its --scope holds whatever the model proposes.
          const chosen = options(ctx.messages)
          // With Vector Local's Web access None the scope is the brain and the repository's files, whatever was proposed
          // or chosen.
          const offline = ResearchRun.offline()
          // The user's own sites to prefer and avoid apply in code, whatever the model proposed: those of their config
          // and those they ticked "Always" for on an earlier card, with the format they ticked when the model chose none.
          const kept = yield* preferred(place, lead.id, ctx.extra?.model as Provider.Model | undefined)
          const plan: Research.Plan = {
            question: params.question.trim(),
            subquestions: params.subquestions.map((item) => item.trim()),
            scope: offline ? "brain" : (chosen.scope ?? params.scope),
            depth: params.depth,
            ...ResearchPlan.domains("prefer_domains", params.prefer_domains, [
              ...(cfg.research?.domains?.prefer ?? []),
              ...(kept.prefer_domains ?? []),
            ]),
            ...ResearchPlan.domains("avoid_domains", params.avoid_domains, [
              ...(cfg.research?.domains?.avoid ?? []),
              ...(kept.avoid_domains ?? []),
            ]),
            ...(params.format ? { format: params.format } : kept.format ? { format: kept.format } : {}),
            ...(params.time_window ? { time_window: params.time_window } : {}),
            ...(params.status ? { status: params.status.slice(0, params.subquestions.length) } : {}),
          }
          const learned = marks(plan, kept)

          // A call that only moves the sub-questions of the approved plan along.
          const found = yield* research.current(ctx)
          const approved = "refused" in found ? undefined : found
          if (approved && ResearchPlan.same(approved.plan, plan)) {
            const next = { ...approved.plan, ...(plan.status ? { status: plan.status } : {}) }
            yield* store.plan(place, approved.run.id, next)
            return {
              title: "Plan updated",
              output: `Noted where the sub-questions stand. Carry on with run ${approved.run.id}.`,
              metadata: { runID: approved.run.id, plan: next, approved: true, answer: "status" as const },
            }
          }

          // A headless run (`vector run` denies the question tool) has no one to answer a card either.
          const unanswerable =
            !interactive ||
            (ctx.deniedResources
              ? (yield* ctx.deniedResources({ permission: "question", patterns: ["*"] })).length > 0
              : false)
          // A child stays at its launcher's size, and a request the user capped at Work stays Focused. A plan no one
          // can answer goes deep only on a Thorough request: the model's own depth never raises a Work one (RC7).
          // A run with Web access None stays Focused too: Deep's researchers work on the web, which it does not reach.
          const ceiling: Research.Depth = offline
            ? "focused"
            : lead.parentID
              ? yield* launcherDepth(lead)
              : size?.capped || (unanswerable && !thorough(size, ctx))
                ? "focused"
                : "deep"
          // A Thorough request (the Depth chip's Deep, `--depth deep`, "be thorough") researches deep (section 5.2), and
          // one the user sized Focused themselves (the Depth chip's Focused) is proposed Focused, whatever the model
          // planned: "Start deep" is then the only way up.
          const proposed: Research.Plan = {
            ...plan,
            depth:
              !lead.parentID && thorough(size, ctx)
                ? ceiling
                : !lead.parentID && focused(ctx)
                  ? "focused"
                  : ResearchPlan.deeper(plan.depth, ceiling),
          }
          const provider = searchProvider({ browser: ResearchBrowser.available(), chosen: chosen.search })
          const estimate = yield* estimateLine(proposed, ctx)
          const start = Effect.fnUntraced(function* (input: Research.Plan) {
            // A run the model re-planned with the same question keeps its run and what it read.
            if (approved && approved.plan.question === input.question) {
              yield* store.plan(place, approved.run.id, input, "running")
              return approved.run.id
            }
            const caps = yield* research.limits(input.depth)
            const run = yield* store.start(place, {
              sessionID: lead.id,
              question: input.question,
              depth: input.depth,
              scope: input.scope,
              plan: input,
              budget: { pages: caps.pages, searches: caps.searches },
              guest: (yield* guests.marked(lead.id)) || (yield* guests.marked(SessionID.make(ctx.sessionID))),
            })
            yield* store.plan(place, run.id, input, "running")
            return run.id
          })

          if (lead.parentID || unanswerable) {
            const runID = yield* start(proposed)
            return {
              title: `Research plan: ${proposed.subquestions.length} sub-question${proposed.subquestions.length === 1 ? "" : "s"}`,
              output: approvedText({
                plan: proposed,
                runID,
                estimate,
                automatic: true,
                provider: provider.provider,
                offline,
              }),
              metadata: {
                runID,
                plan: proposed,
                approved: true,
                answer: "automatic" as const,
                estimate,
                ...(learned ? { learned } : {}),
              },
            }
          }

          // The app's plan card reads the plan as Vector will run it from the running part, rather than from the card's
          // text, so the user edits the real fields; the text stays for every other client.
          const offered = ceiling === "deep" && proposed.depth !== "deep"
          yield* ctx.metadata({
            title: "Research plan",
            metadata: {
              plan: proposed,
              estimate,
              ...(learned ? { learned } : {}),
              card: {
                deep: offered,
                ...(offered ? { deepEstimate: yield* estimateLine({ ...proposed, depth: "deep" }, ctx) } : {}),
                search: provider,
                preferences: {
                  prefer: ResearchPlan.sites(cfg.research?.domains?.prefer, kept.prefer_domains),
                  avoid: ResearchPlan.sites(cfg.research?.domains?.avoid, kept.avoid_domains),
                  ...(kept.format ? { format: kept.format } : {}),
                },
                offline,
              },
            },
          })
          const answers = yield* question
            .ask({
              sessionID: SessionID.make(ctx.sessionID),
              questions: [
                {
                  question: card(proposed, estimate, provider, learned, offline),
                  header: "Research plan",
                  options: [
                    { label: ResearchPlan.START, description: `Research at this depth (${proposed.depth})` },
                    ...(offered
                      ? [
                          {
                            label: ResearchPlan.START_DEEP,
                            description: "Up to 4 researchers and a judge that checks the citations",
                          },
                        ]
                      : []),
                    { label: ResearchPlan.CANCEL, description: "Stop without searching or reading anything" },
                  ],
                  custom: true,
                },
              ],
              ...(ctx.callID ? { tool: { messageID: MessageID.make(ctx.messageID), callID: ctx.callID } } : {}),
            })
            .pipe(Effect.catchTag("QuestionRejectedError", () => Effect.succeed(undefined)))
          const reply = answers?.[0]?.[0]?.trim()
          if (!reply)
            return {
              title: "Plan not approved",
              output:
                "The user dismissed the plan card, so nothing was searched or read. Ask what they would like changed, or wait for them.",
              metadata: {
                plan: proposed,
                approved: false,
                answer: "cancel" as const,
                estimate,
                ...(learned ? { learned } : {}),
              },
            }
          const decided = ResearchPlan.decide(reply, proposed, ceiling, offline)
          if (decided.type === "cancel") {
            return {
              title: "Research cancelled",
              output: "The user cancelled this research. Nothing was searched or read. Say so in one line and stop.",
              metadata: {
                plan: proposed,
                approved: false,
                answer: "cancel" as const,
                estimate,
                ...(learned ? { learned } : {}),
              },
            }
          }
          if (decided.type === "steer")
            return {
              title: "Plan not approved",
              output: `The user replied to the plan instead of starting it: "${reply.slice(0, 2_000)}". Nothing was searched or read. Revise the plan with research_plan.`,
              metadata: {
                plan: proposed,
                approved: false,
                answer: "steer" as const,
                estimate,
                ...(learned ? { learned } : {}),
              },
            }
          const runID = yield* start(decided.plan)
          yield* keep({
            always: decided.always,
            plan: decided.plan,
            place,
            sessionID: lead.id,
            messageID: ctx.messageID,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("keeping the plan card's choices failed", { error: Cause.squash(cause) }),
            ),
          )
          const raised = decided.plan.depth === "deep"
          return {
            title: `Research plan: ${decided.plan.subquestions.length} sub-question${decided.plan.subquestions.length === 1 ? "" : "s"}`,
            output: approvedText({
              plan: decided.plan,
              runID,
              estimate: decided.plan.depth === proposed.depth ? estimate : yield* estimateLine(decided.plan, ctx),
              automatic: false,
              provider: provider.provider,
              offline,
            }),
            metadata: {
              runID,
              plan: decided.plan,
              approved: true,
              answer: decided.answer,
              estimate,
              ...(decided.always.length ? { always: decided.always } : {}),
              // Of what the user approved, what their preferences gave it.
              ...(marks(decided.plan, kept) ? { learned: marks(decided.plan, kept) } : {}),
              ...(raised && size?.tier !== "thorough"
                ? { from: size?.tier ?? ("standard" as const), to: "thorough" as const, source: "user" as const }
                : {}),
            },
          }
        }).pipe(Effect.orDie),
    }

    // What the user ticked "Always" for on an earlier plan card (section 5.4): the sites their preferences in use say to
    // prefer and avoid, and the format, applied to the plan in code. They are the owner's personal memory, so none of it
    // applies in a session an invited guest has acted in, or on a free model that may train on prompts.
    function preferred(place: Brain.Place, sessionID: SessionID, model: Provider.Model | undefined) {
      return Effect.gen(function* () {
        if ((model && freeModelMayTrain(model)) || (yield* guests.marked(sessionID))) return NOTHING_KEPT
        const kept = (yield* brain.list(place, { scope: "personal" })).filter(
          (entry) => entry.kind === "preference" && entry.status === "active",
        )
        const sites = (field: "prefer_domains" | "avoid_domains") => [
          ...new Set(
            kept
              .filter((entry) => entry.text.startsWith(ALWAYS[field]))
              .flatMap((entry) => entry.text.slice(ALWAYS[field].length).split(","))
              .map((site) => site.trim().toLowerCase())
              .filter(Boolean),
          ),
        ]
        const format = kept
          .filter((entry) => entry.text.startsWith(ALWAYS.format))
          .map((entry) => decodeFormat(entry.text.slice(ALWAYS.format.length).trim()))
          .find(Option.isSome)
        return {
          prefer_domains: sites("prefer_domains"),
          avoid_domains: sites("avoid_domains"),
          ...(format ? { format: format.value } : {}),
        } satisfies Learned
      })
    }

    // The plan card's "Always" boxes (section 6.3): the user asked Vector to keep the sites or the format they chose for
    // every research run, so each becomes their preference in use, with its own words as the evidence of what they
    // ticked. A later choice adds sites to the ones kept, newest first, or replaces the format. Nothing is kept from a
    // session an invited guest has acted in, and what Settings > Memory turned off the brain refuses.
    function keep(input: {
      readonly always: readonly (keyof typeof ALWAYS)[]
      readonly plan: Research.Plan
      readonly place: Brain.Place
      readonly sessionID: SessionID
      readonly messageID: string
    }) {
      return Effect.gen(function* () {
        if (input.always.length === 0 || (yield* guests.marked(input.sessionID))) return
        const kept = (yield* brain.list(input.place, { scope: "personal" })).filter(
          (entry) => entry.kind === "preference" && entry.origin === "agent" && entry.status === "active",
        )
        const results = yield* Effect.forEach(input.always, (field) => {
          const previous = kept.find((entry) => entry.text.startsWith(ALWAYS[field]))
          const text = alwaysText(field, input.plan, previous?.text)
          if (!text || text === previous?.text) return Effect.succeed(undefined)
          return brain.propose(input.place, {
            kind: "preference",
            text,
            scope: "personal",
            facet: field === "format" ? "format" : "sources",
            origin: "agent",
            evidence: { type: "message", quote: text, verified: true },
            learner: true,
            sessionID: input.sessionID,
            ...(previous ? { supersedes: previous.id } : {}),
          })
        })
        const entryIDs = results.flatMap((result) =>
          result?.type === "added" || result?.type === "superseded" || result?.type === "promoted"
            ? [result.entry.id]
            : [],
        )
        if (entryIDs.length)
          yield* events.publish(MemoryEvent.Learned, {
            sessionID: input.sessionID,
            entryIDs,
            messageID: input.messageID,
          })
      })
    }

    // The deepest a child's run may go: deep only when the request that launched it is Thorough.
    function launcherDepth(lead: {
      readonly id: SessionID
      readonly parentID?: SessionID
      readonly metadata?: Record<string, unknown>
    }) {
      return Effect.gen(function* () {
        const record = SubagentLifecycle.read(lead)
        if (!record || !lead.parentID) return "focused" as const
        const launcher = yield* MessageV2.getInfo({
          sessionID: lead.parentID,
          messageID: MessageID.make(record.parentMessageID),
        }).pipe(
          Effect.provideService(Database.Service, database),
          Effect.catch(() => Effect.succeed(undefined)),
        )
        return launcher?.role === "assistant" && launcher.size === "thorough" ? ("deep" as const) : ("focused" as const)
      })
    }

    // The plan card's estimate line, in the copy deck's words; always called an estimate.
    function estimateLine(plan: Research.Plan, ctx: Tool.Context) {
      return Effect.gen(function* () {
        const caps = yield* research.limits(plan.depth)
        const budget = (yield* guard.snapshot(SessionID.make(ctx.sessionID)))?.budget
        // A root research run without a cap of the user's runs under research's own defaults, which follow the plan's
        // depth: a plan started deep runs under Deep's.
        const defaults = [yield* research.limits("focused"), yield* research.limits("deep")]
        const own = defaults.some((item) => item.usd === budget?.usd && item.steps === budget?.steps)
          ? undefined
          : budget
        const model = ctx.extra?.model as Provider.Model | undefined
        const price = model ? SpendGuard.priceOf(model.cost) : undefined
        const kind = !model
          ? "unknown"
          : SpendGuard.costKindOf({
              codium: Billing.isCodium(model.providerID),
              free: isFreeModel(model) || model.freeModel !== undefined,
              listed: price !== undefined,
              oauthPlan: false,
              local: ModelSlots.local(model.api.url),
            })
        const compact = (model?.limit.context ?? Infinity) < 32_000
        const estimate = ResearchEstimate.estimate({
          pages: caps.pages,
          searches: caps.searches,
          researchers: plan.depth === "deep" ? caps.researchers : 0,
          judge: plan.depth === "deep",
          prompt: measured(ctx) ?? BASE_PROMPT,
          chunkTokens: compact ? ResearchReader.COMPACT_TOKENS : ResearchReader.CHUNK_TOKENS,
          kind,
          ...(price ? { price } : {}),
        })
        return ResearchEstimate.copy({
          pages: caps.pages,
          searches: caps.searches,
          estimate,
          kind,
          // Research's default caps apply only when the user has none of their own.
          ...(own?.usd !== undefined ? { capUsd: own.usd } : own?.steps === undefined ? { capUsd: caps.usd } : {}),
          capSteps: own?.steps ?? caps.steps,
        })
      })
    }
  }),
)

// Whether the request is Thorough: by Vector's sizing of it, or without one by the sender's own pick (the Depth chip's
// Deep, or the CLI's deep depth), which the request message keeps.
function thorough(size: TaskSizeContext | undefined, ctx: Tool.Context) {
  if (size) return size.tier === "thorough"
  const request = ctx.messages.findLast((message) => message.info.role === "user")?.info
  return request?.role === "user" && request.size === "thorough"
}

// The user chose Focused for this request themselves: the composer sends Focused as the size standard.
function focused(ctx: Tool.Context) {
  const request = ctx.messages.findLast((message) => message.info.role === "user")?.info
  return request?.role === "user" && request.size === "standard"
}

// The base prompt this session measured on its model: its last finished step's prompt, cached part included.
function measured(ctx: Tool.Context) {
  const last = ctx.messages.findLast(
    (message) => message.info.role === "assistant" && message.info.time.completed !== undefined,
  )?.info
  if (last?.role !== "assistant") return undefined
  const tokens = last.tokens.input + last.tokens.cache.read + last.tokens.cache.write
  return tokens > 0 ? tokens : undefined
}

// What of the plan its card marks "from your preferences": the sites and the format the user's preferences gave it,
// of those it still carries. Nothing when they gave it none.
function marks(plan: Research.Plan, kept: Learned): Learned | undefined {
  const prefer = (kept.prefer_domains ?? []).filter((site) => plan.prefer_domains?.includes(site))
  const avoid = (kept.avoid_domains ?? []).filter((site) => plan.avoid_domains?.includes(site))
  const format = kept.format !== undefined && plan.format === kept.format ? kept.format : undefined
  if (!prefer.length && !avoid.length && !format) return undefined
  return {
    ...(prefer.length ? { prefer_domains: prefer } : {}),
    ...(avoid.length ? { avoid_domains: avoid } : {}),
    ...(format ? { format } : {}),
  }
}

const decodeFormat = Schema.decodeUnknownOption(Research.Format)
const NOTHING_KEPT: Learned = {}

// What each of the plan card's "Always" boxes keeps: the preference's words before the sites or the format.
const ALWAYS = {
  prefer_domains: "Always prefer these sites as research sources: ",
  avoid_domains: "Never use these sites as research sources: ",
  format: "Always write research reports as a ",
} as const

// The preference an "Always" box writes: the plan's sites before the ones kept already, as many as one memory holds, or
// the plan's format. Nothing when the plan has none.
function alwaysText(field: keyof typeof ALWAYS, plan: Research.Plan, previous?: string) {
  if (field === "format") return plan.format ? `${ALWAYS.format}${plan.format}` : undefined
  const sites = [
    ...new Set([
      ...(plan[field] ?? []).map((site) => site.trim().toLowerCase()),
      ...(previous?.slice(ALWAYS[field].length).split(", ") ?? []),
    ]),
  ].filter(Boolean)
  const fitting = sites.reduce<string[]>(
    (all, site) => (`${ALWAYS[field]}${[...all, site].join(", ")}`.length <= Brain.LIMIT.agent ? [...all, site] : all),
    [],
  )
  return fitting.length ? `${ALWAYS[field]}${fitting.join(", ")}` : undefined
}

// What the plan card shows: the plan, its scope and depth, the estimate, and what search is set up, or that Vector
// Local's Web access is None. The sites and format the user's preferences gave the plan are marked as theirs.
function card(
  plan: Research.Plan,
  estimate: string,
  provider: ReturnType<typeof searchProvider>,
  learned: Learned | undefined,
  offline: boolean,
) {
  const mark = (site: string, kept?: readonly string[]) =>
    kept?.includes(site) ? `${site} (${FROM_PREFERENCES})` : site
  return [
    `Research: ${plan.question}`,
    ...plan.subquestions.map((item, index) => `${index + 1}. ${item}`),
    `Scope: ${ResearchPlan.scopeLabel(plan.scope)}`,
    `Depth: ${plan.depth === "deep" ? "Deep: up to 4 researchers and a judge" : "Focused: one agent, plus up to 2 researchers when the question has independent parts"}`,
    ...(plan.prefer_domains?.length
      ? [`Prefer: ${plan.prefer_domains.map((site) => mark(site, learned?.prefer_domains)).join(", ")}`]
      : []),
    ...(plan.avoid_domains?.length
      ? [`Avoid: ${plan.avoid_domains.map((site) => mark(site, learned?.avoid_domains)).join(", ")}`]
      : []),
    ...(plan.time_window ? [`Time window: ${plan.time_window}`] : []),
    ...(plan.format ? [`Format: ${plan.format}${learned?.format ? ` (${FROM_PREFERENCES})` : ""}`] : []),
    estimate,
    ...(offline ? [ResearchRun.OFFLINE] : []),
    ...(provider.provider === "none" && plan.scope !== "brain" ? [provider.reason] : []),
  ].join("\n")
}

function approvedText(input: {
  readonly plan: Research.Plan
  readonly runID: string
  readonly estimate: string
  readonly automatic: boolean
  readonly provider: string
  readonly offline: boolean
}) {
  return [
    input.automatic
      ? `The plan is approved within the request that launched this research (${input.plan.depth}).`
      : `The user approved the plan (${input.plan.depth}).`,
    `Run ${input.runID}. ${input.estimate}`,
    ...(input.offline
      ? [ResearchRun.OFFLINE, "Use the memory tool and the repository's files (read, grep, glob, list) yourself."]
      : [
          input.provider === "none"
            ? "Nothing is searched on the web here: use this repository's brain and files, and the addresses in the user's message."
            : "Search with research_search, read with research_read, and save each finding with research_note.",
          input.plan.depth === "deep"
            ? "Give independent sub-questions to researchers with the task tool, each brief written in public terms."
            : "Do the research yourself; hand a sub-question to a researcher only when it is independent of the rest.",
        ]),
    "Then write the report with research_report.",
  ].join("\n")
}
