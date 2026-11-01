export * as ResearchPlanTool from "./research-plan"

import { Billing } from "@vectordevai/schema/billing"
import { Effect, Layer, Schema } from "effect"
import { Research } from "@vectordevai/schema/research"
import { makeLocationNode } from "../effect/app-node"
import { ModelSlots } from "../local-mode/model-slots"
import { PermissionV2 } from "../permission"
import { QuestionV2 } from "../question"
import { ResearchEstimate } from "../research/estimate"
import { ResearchPlan } from "../research/plan"
import { ResearchReader } from "../research/reader"
import { ResearchStore } from "../research/store"
import { SessionRunnerModel } from "../session/runner/model"
import type { SessionMessage } from "../session/message"
import type { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { SpendGuard } from "../spend-guard"
import { ResearchRunV2 } from "./research-run"
import { ResearchSearchTool } from "./research-search"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

// research_plan on the V2 runner (section 5.4): proposes the plan, works out what it is likely to cost, and asks the
// user through the plan card (Start or Cancel; a typed reply is a steer). The run starts in the store only once the
// plan is approved, so nothing is searched or read before. A call that only moves sub-questions along never asks
// again. Where no one can answer the card (a child or helper session, or an agent denied the question tool), the plan is
// approved on its own. This runner has no researchers and no judge yet, so every run here is Focused.

export const name = "research_plan"

export const description = `Plans a Deep research run and asks the user to approve it on a plan card. Call it first: nothing is searched or read before the user approves the plan.

- question: the research question, restated in one or two sentences.
- subquestions: 1 to 8 sub-questions that together answer it.
- scope: web, web+brain (the web and this repository's files), or brain (the repository's files only).
- depth: research on this runner is focused (you research the plan yourself); deep runs with researchers on the V1 runner only.
- prefer_domains, avoid_domains, format, time_window: optional. The user's own preferred and avoided sites are added in code.

The user answers Start or Cancel, or replies in their own words. A reply is a steer: revise the plan and call research_plan again. When a sub-question is answered or dropped, call research_plan with the same question and sub-questions and only the new status: that never asks the user again.`

export const Input = Schema.Struct({
  question: Schema.String.check(Schema.isLengthBetween(1, 1_000)).annotate({
    description: "The research question, restated in one or two sentences",
  }),
  subquestions: Schema.Array(Schema.String.check(Schema.isLengthBetween(1, 300)))
    .check(Schema.isLengthBetween(1, 8))
    .annotate({ description: "One to eight sub-questions that together answer the question" }),
  scope: Research.Scope.annotate({
    description: "web, web+brain (the web and this repository's files), or brain (the repository's files only)",
  }),
  depth: Research.Depth.annotate({ description: "focused; a deep plan runs Focused on this runner" }),
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

/** What a call records: the run it approved and how, which research's other tools read back. */
export const Metadata = Schema.Struct({
  runID: Schema.optional(Schema.String),
  plan: Schema.optional(Research.Plan),
  approved: Schema.Boolean,
  answer: Schema.optional(Schema.Literals(["start", "start-deep", "cancel", "steer", "automatic", "status"])),
  estimate: Schema.optional(Schema.String),
  always: Schema.optional(Schema.Array(Schema.Literals(["prefer_domains", "avoid_domains", "format"]))),
})

const Output = Schema.Struct({ text: Schema.String, metadata: Metadata })

/** The depth research runs at on this runner: it has no researchers and no judge yet. */
const DEPTH: Research.Depth = "focused"
// A base prompt to estimate with before the session has measured one on this model.
const BASE_PROMPT = 12_000

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const research = yield* ResearchRunV2.Service
    const store = yield* ResearchStore.Service
    const sessions = yield* SessionStore.Service
    const question = yield* QuestionV2.Service
    const permission = yield* PermissionV2.Service
    const models = yield* SessionRunnerModel.Service
    const guard = yield* SpendGuard.Service

    // The plan card's estimate line, in the copy deck's words; always called an estimate.
    const estimateLine = Effect.fnUntraced(function* (
      plan: Research.Plan,
      session: SessionSchema.Info,
      messages: readonly SessionMessage.Message[],
    ) {
      const caps = yield* research.limits(plan.depth)
      const budget = (yield* guard.snapshot(session.id))?.budget
      // A run without a cap of the user's runs under research's own defaults (the runner applies them).
      const own = budget?.usd === caps.usd && budget?.steps === caps.steps ? undefined : budget
      const resolved = yield* models.resolve(session).pipe(Effect.orElseSucceed(() => undefined))
      const price = resolved ? SessionRunnerModel.priceOf(resolved, 0) : undefined
      const kind = !resolved
        ? "unknown"
        : SpendGuard.costKindOf({
            codium: Billing.isCodium(resolved.provider),
            free: SessionRunnerModel.isFree(resolved),
            listed: price !== undefined,
            oauthPlan: false,
            local: ModelSlots.local(resolved.route.endpoint.baseURL, { model: resolved.id }),
          })
      const compact = (resolved?.route.defaults.limits?.context ?? Infinity) < 32_000
      const estimate = ResearchEstimate.estimate({
        pages: caps.pages,
        searches: caps.searches,
        researchers: 0,
        judge: false,
        prompt: measured(messages) ?? BASE_PROMPT,
        chunkTokens: compact ? ResearchReader.COMPACT_TOKENS : ResearchReader.CHUNK_TOKENS,
        kind,
        ...(price ? { price } : {}),
      })
      return ResearchEstimate.copy({
        pages: caps.pages,
        searches: caps.searches,
        estimate,
        kind,
        ...(own?.usd !== undefined ? { capUsd: own.usd } : own?.steps === undefined ? { capUsd: caps.usd } : {}),
        capSteps: own?.steps ?? caps.steps,
      })
    })

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          structured: Metadata,
          toStructuredOutput: ({ output }) => output.metadata,
          toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const session = yield* sessions.get(context.sessionID)
              if (!session) return yield* Effect.die(`Session not found: ${context.sessionID}`)
              const place = research.place()
              const settings = yield* research.settings()
              // With Vector Local's Web access None the scope is the brain and the repository's files, whatever was
              // proposed.
              const offline = ResearchPlan.offline()
              // The user's own sites to prefer and avoid apply in code, whatever the model proposed; a repository's
              // config may add sites to avoid.
              const plan: Research.Plan = {
                question: input.question.trim(),
                subquestions: input.subquestions.map((item) => item.trim()),
                scope: offline ? "brain" : input.scope,
                depth: DEPTH,
                ...ResearchPlan.domains("prefer_domains", input.prefer_domains, settings.own.domains?.prefer),
                ...ResearchPlan.domains("avoid_domains", input.avoid_domains, [
                  ...(settings.own.domains?.avoid ?? []),
                  ...settings.avoid,
                ]),
                ...(input.format ? { format: input.format } : {}),
                ...(input.time_window ? { time_window: input.time_window } : {}),
                ...(input.status ? { status: input.status.slice(0, input.subquestions.length) } : {}),
              }

              // A call that only moves the sub-questions of the approved plan along.
              const found = yield* research.current(context)
              const approved = "refused" in found ? undefined : found
              if (approved && ResearchPlan.same(approved.plan, plan)) {
                const next = { ...approved.plan, ...(plan.status ? { status: plan.status } : {}) }
                yield* store.plan(place, approved.run.id, next)
                return {
                  text: `Noted where the sub-questions stand. Carry on with run ${approved.run.id}.`,
                  metadata: { runID: approved.run.id, plan: next, approved: true, answer: "status" as const },
                }
              }

              const messages =
                approved?.messages ?? (yield* sessions.all(session.id).pipe(Effect.orElseSucceed(() => [])))
              const provider = ResearchSearchTool.provider()
              const estimate = yield* estimateLine(plan, session, messages)
              const start = Effect.fnUntraced(function* (chosen: Research.Plan) {
                // A run the model re-planned with the same question keeps its run and what it read.
                if (approved && approved.plan.question === chosen.question) {
                  yield* store.plan(place, approved.run.id, chosen, "running")
                  return approved.run.id
                }
                const caps = yield* research.limits(chosen.depth)
                const run = yield* store.start(place, {
                  sessionID: session.id,
                  question: chosen.question,
                  depth: chosen.depth,
                  scope: chosen.scope,
                  plan: chosen,
                  budget: { pages: caps.pages, searches: caps.searches },
                  guest: yield* research.guest(session.id),
                })
                yield* store.plan(place, run.id, chosen, "running")
                return run.id
              })

              // Only the person who typed in this session answers its card: a child's or a helper's has no one to,
              // nor has an agent the question tool is denied to.
              const unanswerable =
                session.parentID !== undefined ||
                session.internal !== undefined ||
                (yield* permission
                  .deniedResources({
                    action: "question",
                    resources: ["*"],
                    sessionID: context.sessionID,
                    agent: context.agent,
                  })
                  .pipe(Effect.orElseSucceed(() => ["*"]))).length > 0
              if (unanswerable) {
                const runID = yield* start(plan)
                return {
                  text: approvedText({ plan, runID, estimate, automatic: true, provider: provider.provider, offline }),
                  metadata: { runID, plan, approved: true, answer: "automatic" as const, estimate },
                }
              }

              const answers = yield* question
                .ask({
                  sessionID: context.sessionID,
                  questions: [
                    {
                      question: card(plan, estimate, provider, offline),
                      header: "Research plan",
                      options: [
                        { label: ResearchPlan.START, description: `Research at this depth (${plan.depth})` },
                        { label: ResearchPlan.CANCEL, description: "Stop without searching or reading anything" },
                      ],
                      custom: true,
                    },
                  ],
                  tool: { messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                .pipe(Effect.catchTag("QuestionV2.RejectedError", () => Effect.succeed(undefined)))
              const reply = answers?.[0]?.[0]?.trim()
              if (!reply)
                return {
                  text: "The user dismissed the plan card, so nothing was searched or read. Ask what they would like changed, or wait for them.",
                  metadata: { plan, approved: false, answer: "cancel" as const, estimate },
                }
              const decided = ResearchPlan.decide(reply, plan, DEPTH, offline)
              if (decided.type === "cancel")
                return {
                  text: "The user cancelled this research. Nothing was searched or read. Say so in one line and stop.",
                  metadata: { plan, approved: false, answer: "cancel" as const, estimate },
                }
              if (decided.type === "steer")
                return {
                  text: `The user replied to the plan instead of starting it: "${reply.slice(0, 2_000)}". Nothing was searched or read. Revise the plan with research_plan.`,
                  metadata: { plan, approved: false, answer: "steer" as const, estimate },
                }
              const runID = yield* start(decided.plan)
              return {
                text: approvedText({
                  plan: decided.plan,
                  runID,
                  estimate,
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
                },
              }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/research_plan",
  layer,
  deps: [
    ToolRegistry.node,
    ResearchRunV2.node,
    ResearchStore.node,
    SessionStore.node,
    QuestionV2.node,
    PermissionV2.node,
    SessionRunnerModel.node,
    SpendGuard.node,
  ],
})

// The base prompt this session measured on its model: its last finished step's prompt, cached part included.
function measured(messages: readonly SessionMessage.Message[]) {
  const last = messages.findLast(
    (message): message is SessionMessage.Assistant =>
      message.type === "assistant" && message.time.completed !== undefined && message.tokens !== undefined,
  )
  const tokens = last?.tokens ? last.tokens.input + last.tokens.cache.read + last.tokens.cache.write : 0
  return tokens > 0 ? tokens : undefined
}

// What the plan card shows: the plan, its scope and depth, the estimate, and what search is set up, or that Vector
// Local's Web access is None.
function card(plan: Research.Plan, estimate: string, provider: ResearchSearchTool.Provider, offline: boolean) {
  return [
    `Research: ${plan.question}`,
    ...plan.subquestions.map((item, index) => `${index + 1}. ${item}`),
    `Scope: ${ResearchPlan.scopeLabel(plan.scope)}`,
    "Depth: Focused: one agent. Deep's researchers and judge are not on this runner yet.",
    ...(plan.scope === "brain" || offline ? [] : [ResearchRunV2.PRIVATE]),
    ...(plan.prefer_domains?.length ? [`Prefer: ${plan.prefer_domains.join(", ")}`] : []),
    ...(plan.avoid_domains?.length ? [`Avoid: ${plan.avoid_domains.join(", ")}`] : []),
    ...(plan.time_window ? [`Time window: ${plan.time_window}`] : []),
    ...(plan.format ? [`Format: ${plan.format}`] : []),
    estimate,
    ...(offline ? [ResearchPlan.OFFLINE] : []),
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
      ? [ResearchPlan.OFFLINE, "Use the repository's files (read, grep, glob) yourself."]
      : [
          input.provider === "none"
            ? "Nothing is searched on the web here: use this repository's files, and the addresses in the user's message."
            : "Search with research_search, read with research_read, and save each finding with research_note.",
        ]),
    "Then write the report with research_report.",
  ].join("\n")
}
