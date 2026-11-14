export * as SessionWorkflow from "./workflow"

import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainWorkflow } from "@vectordevai/core/brain/workflow"
import type { CodiumAuto } from "@vectordevai/core/codium-auto"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { TaskSize } from "@vectordevai/core/task-size"
import { SessionV1 } from "@vectordevai/core/v1/session"
import type { Agent } from "@/agent/agent"
import { GENERAL_SUBAGENT } from "@/agent/subagent-kind"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Provider } from "@/provider/provider"
import { isRecord } from "@/util/record"
import { Instruction } from "./instruction"
import { SessionMemory } from "./memory"
import type { MessageID, SessionID } from "./schema"
import { Session } from "./session"
import { SessionTaskSize } from "./task-size"

// Self-tuned workflows in the session runtime (section 6): what each build request ran with and how it went is recorded
// once its run ends, and where nobody chose for Vector, a request's first step may take a cheaper default the
// repository's runs earned: Thorough's high effort back to the model's default, working solo, or the small model for
// general subagents. The decision is made once per request and carried on its assistant messages, so it never moves
// within a request, and effort never changes while the provider's cache is warm.

/** Option keys that set reasoning or thinking; a run whose agent, model or provider sets one is someone's choice. */
export const EFFORT_KEYS: readonly string[] = [
  "reasoningEffort",
  "reasoning_effort",
  "reasoning",
  "reasoningSummary",
  "thinking",
  "thinkingConfig",
  "thinkingBudget",
  "enable_thinking",
  "effort",
]

/** A learned default as the assistant message records it. `variant` stays the user's own pick. */
export type Workflow = NonNullable<SessionV1.Assistant["workflow"]>

/** What a build step ran with: the learned default its message records, and what its run's observation keeps. */
export type Step = {
  readonly request: SessionTaskSize.Request
  readonly effortTier: TaskSize.Tier
  readonly model: Provider.Model
  readonly effort: string
  readonly source: BrainWorkflow.EffortSource
  readonly workflow?: Workflow
  /** The advice behind it, where this step decided it. */
  readonly advice?: BrainWorkflow.Advice
}

export interface Interface {
  readonly autoModels?: (sessionID: SessionID, tier: TaskSize.Tier) => Effect.Effect<readonly CodiumAuto.Suggestion[]>
  /**
   * Whether a request may take a learned default (I10): the build agent's own run in a root session with no guest, its
   * size from Vector's rules, no variant from the user or the agent, no reasoning option from the agent, the model or
   * the provider, `sizing.learn` not off, and workflow learning set to apply.
   */
  readonly eligible: (input: {
    readonly session: Session.Info
    readonly agent: Agent.Info
    readonly stepAgent: Agent.Info
    readonly user: SessionV1.User
    readonly model: Provider.Model
    readonly provider: Provider.Info
    readonly result: TaskSize.Result
    readonly guest: boolean
  }) => Effect.Effect<boolean>
  /** The cheaper default the repository's runs advise for a request, with no exploration while the cache is warm. */
  readonly advice: (input: {
    readonly session: Session.Info
    readonly tier: TaskSize.Tier
    readonly effortTier: TaskSize.Tier
    readonly result: TaskSize.Result
    readonly model: Provider.Model
    readonly requestID: string
    readonly warm: boolean
    readonly offered: readonly string[]
    readonly namedSubagents: boolean
  }) => Effect.Effect<BrainWorkflow.Advice | undefined>
  /** The advice the session's latest request was given in this process. */
  readonly current: (sessionID: SessionID) => Effect.Effect<BrainWorkflow.Advice | undefined>
  /** Records how a run's last request went, once the run is over. Numbers only: no prompt or file text. */
  readonly observe: (input: {
    readonly session: Session.Info
    readonly taught: ReadonlyMap<MessageID, { readonly message: SessionV1.WithParts; readonly tier: TaskSize.Tier }>
    readonly since: MessageID
    readonly run: SpendGuard.Run | undefined
    /** Background subagents of the run still running when it ended. */
    readonly background: number
    readonly step: Step | undefined
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@vector/SessionWorkflow") {}

// Sessions whose latest advice `current` keeps; the oldest go first.
const KEPT = 256

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const workflow = yield* BrainWorkflow.Service
    const brain = yield* Brain.Service
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service
    const provider = yield* Provider.Service
    const instruction = yield* Instruction.Service
    const sessions = yield* Session.Service
    const guests = yield* FreeModelGuests.Service
    const latest = new Map<SessionID, BrainWorkflow.Advice>()

    const eligible = Effect.fn("SessionWorkflow.eligible")(function* (input: Parameters<Interface["eligible"]>[0]) {
      if (flags.pure || input.guest || input.session.parentID || input.session.internal) return false
      // The research lead takes its effort from the request too, but its runs are research, not build work.
      if (input.agent.name !== "build") return false
      if (!automatic(input.result)) return false
      if (picked(input.user)) return false
      if (input.stepAgent.variant || sets(input.stepAgent.options)) return false
      if (sets(input.model.options) || sets(input.provider.options)) return false
      if ((yield* config.get()).sizing?.learn === false) return false
      return (yield* brain.learnSettings()).workflow === "apply"
    })

    const advice = Effect.fn("SessionWorkflow.advice")(function* (input: Parameters<Interface["advice"]>[0]) {
      const place = yield* instruction.place()
      const small = yield* provider.getSmallModel(input.model.providerID, input.model.id)
      const found = yield* workflow.advice(place, {
        effortTier: input.effortTier,
        providerID: input.model.providerID,
        modelID: input.model.id,
        defaultEffort: TaskSize.effort(input.effortTier),
        subagentsOffered: input.offered.includes("task"),
        namedSubagents: input.namedSubagents,
        smallCheaper: cheaper(small, input.model),
        requestID: input.requestID,
      })
      // Trying a setting is never worth rewriting a warm cache.
      const chosen = found && !(input.warm && found.source === "explore") ? found : undefined
      latest.delete(input.session.id)
      if (chosen) latest.set(input.session.id, chosen)
      if (latest.size > KEPT) latest.delete(latest.keys().next().value!)
      yield* Effect.annotateCurrentSpan({ "workflow.advice": chosen?.source ?? "none" })
      return chosen
    })

    const current = (sessionID: SessionID) => Effect.sync(() => latest.get(sessionID))

    const observe = Effect.fn("SessionWorkflow.observe")(function* (input: Parameters<Interface["observe"]>[0]) {
      const step = input.step
      if (!step || flags.pure || input.session.parentID || input.session.internal) return
      // A Vector an agent started runs prompts that agent wrote: nothing it does is evidence of how this owner works.
      if (SessionMemory.agentStarted()) return
      if (yield* guests.marked(input.session.id)) return
      if ((yield* brain.learnSettings()).workflow === "off") return
      const place = yield* instruction.place()
      const msgs = yield* sessions.messages({ sessionID: input.session.id }).pipe(Effect.orDie)
      const asked = [...input.taught.values()]
        .map((item) => item.message.info)
        .filter((info) => info.role === "user")
        .toSorted((a, b) => (a.id < b.id ? -1 : 1))
      const last = asked.at(-1)
      const opening = step.request.users[0]?.info
      if (!last || !opening) return
      const turn = msgs.filter((message) => message.info.id >= opening.id)
      const ran = msgs.filter((message) => message.info.role === "assistant" && message.info.id > input.since)
      const tasks = ran.flatMap((message) =>
        message.parts.flatMap((part) => (part.type === "tool" && part.tool === "task" ? [part] : [])),
      )
      const judged = tasks.filter((part) => part.metadata?.judge !== undefined)
      const delegated = tasks.filter((part) => part.metadata?.judge === undefined)
      const small = yield* provider.getSmallModel(step.model.providerID, step.model.id)
      // Only general subagents count: the advice moves them, while explore runs on the small model whenever it is
      // cheaper (task.ts) and the specialists keep their own models, so neither says how a general one would do there.
      const placed = delegated.flatMap(models)
      const kinds = [
        ...new Set(
          placed.map((model) =>
            model === `${step.model.providerID}/${step.model.id}`
              ? "parent"
              : small && model === `${small.providerID}/${small.id}`
                ? "small"
                : "other",
          ),
        ),
      ]
      const subagentModel =
        kinds.length === 1 && kinds[0] !== "other"
          ? (kinds[0] as "parent" | "small")
          : kinds.filter((kind) => kind !== "other").length > 0
            ? ("mixed" as const)
            : undefined
      const failed = SessionMemory.failed(turn)
      const taint = SessionMemory.taint(msgs)
      const signal = SessionMemory.recovered(msgs, opening.time.created)
        ? ("recovered" as const)
        : SessionMemory.judged(turn)
          ? ("judged" as const)
          : failed
      const usage = yield* spent(input.session.id, input.since, opening.time.created)
      const units = input.run?.steps === usage.steps.length && provider.codiumUnits
        ? yield* provider.codiumUnits(usage.steps) : undefined
      // Unknown is not zero: a local, plan, free or unknown step leaves the run's cost unknown.
      const priced =
        input.run !== undefined &&
        input.run.unpricedSteps === 0 &&
        Object.entries(input.run.kinds).every(([kind, steps]) => kind === "priced" || !steps)
      yield* workflow.record(place, {
        sessionID: input.session.id,
        requestID: last.id,
        at: Date.now(),
        tier: step.request.tier,
        effortTier: step.effortTier,
        agent: "build",
        providerID: step.model.providerID,
        modelID: step.model.id,
        effort: step.effort,
        effortSource: step.source,
        subagents: delegated.reduce((sum, part) => sum + launches(part), 0),
        ...(subagentModel ? { subagentModel } : {}),
        subagentModels: Object.fromEntries(
          [...Map.groupBy(placed, (model) => model).entries()].map(([model, items]) => [model, items.length]),
        ),
        judgeRounds: judged.length,
        outcome: signal === "recovered" || signal === "judged" ? "pass" : signal ? "fail" : "none",
        ...(signal ? { signal } : {}),
        ...(priced ? { costUsd: input.run!.spentUsd } : {}),
        costKinds: input.run?.kinds ?? {},
        steps: input.run?.steps ?? 0,
        unpricedSteps: input.run?.unpricedSteps ?? 0,
        tokens: usage.tokens,
        ...(units === undefined ? {} : { codiumUnits: units }),
        partial:
          input.background > 0 ||
          turn.some((message) => message.parts.some((part) => part.type === "tool" && part.tool === "workflow")),
        ...(input.run?.stopped ? { stop: input.run.stopped.reason } : {}),
        ...(taint ? { taint } : {}),
        ...(step.advice ? { advice: step.advice } : {}),
      })
    })

    // Tokens of the run's assistant messages, in the session and in every session launched from it since the request
    // opened (subagents, the judge and theirs).
    const spent = Effect.fnUntraced(function* (sessionID: SessionID, since: MessageID, opened: number) {
      const ids = yield* descendants(sessionID, opened)
      const all = yield* Effect.forEach([sessionID, ...ids], (id) =>
        sessions.messages({ sessionID: id }).pipe(Effect.catch(() => Effect.succeed([] as SessionV1.WithParts[]))),
      )
      const steps = all
        .flat()
        .flatMap((message) => (message.info.role === "assistant" && message.info.id > since ? [message.info] : []))
      return { steps: steps.filter((info) => info.tokens.input + info.tokens.output + info.tokens.reasoning +
        info.tokens.cache.read + info.tokens.cache.write > 0).map((info) => ({
        providerID: info.providerID, modelID: info.modelID,
        input: info.tokens.input, output: info.tokens.output,
        reasoning: info.tokens.reasoning, cacheRead: info.tokens.cache.read,
      })), tokens: steps.reduce(
          (sum, info) => ({
            input: sum.input + info.tokens.input,
            output: sum.output + info.tokens.output,
            reasoning: sum.reasoning + info.tokens.reasoning,
            cacheRead: sum.cacheRead + info.tokens.cache.read,
          }),
          { input: 0, output: 0, reasoning: 0, cacheRead: 0 },
        ) }
    })

    const descendants = (sessionID: SessionID, opened: number): Effect.Effect<SessionID[]> =>
      sessions.children(sessionID).pipe(
        Effect.map((children) => children.filter((child) => child.time.created >= opened)),
        Effect.flatMap((children) =>
          Effect.forEach(children, (child) =>
            descendants(child.id, opened).pipe(Effect.map((below) => [child.id, ...below])),
          ),
        ),
        Effect.map((found) => found.flat()),
      )

    const autoModels = Effect.fn("SessionWorkflow.autoModels")(function* (sessionID: SessionID, tier: TaskSize.Tier) {
      if (flags.pure || Config.local().enabled || SessionMemory.agentStarted() ||
        (yield* config.get()).sizing?.learn === false || (yield* guests.marked(sessionID))) return []
      const session = yield* sessions.get(sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!session || session.parentID || session.internal || !workflow.autoModels) return []
      return yield* workflow.autoModels(yield* instruction.place(), tier)
    })
    return Service.of({ eligible, advice, current, observe, autoModels })
  }),
)

/**
 * The learned default a request's assistant message records. While the cache is warm the effort is the request before
 * it's (its learned default, or none), whatever the runs advise now; split and subagent model take the new advice.
 */
export function applied(
  advice: BrainWorkflow.Advice | undefined,
  input: { readonly warm: boolean; readonly previous?: Workflow },
): Workflow | undefined {
  const effort = input.warm ? input.previous?.effort : advice?.effort
  // The advice says why, unless all that is left of it is the effort carried from the request before.
  const own = advice && (advice.split || advice.subagentModel || (advice.effort && effort)) ? advice : undefined
  const said = own ?? (effort ? input.previous : undefined)
  if (!said) return undefined
  return {
    ...(effort ? { effort } : {}),
    ...(advice?.split ? { split: advice.split } : {}),
    ...(advice?.subagentModel ? { subagentModel: advice.subagentModel } : {}),
    source: said.source,
    reason: said.reason,
  }
}

/** The learned default a request's assistant messages record, from its first step that had one. */
export function recorded(request: Pick<SessionTaskSize.Request, "messages">) {
  return request.messages.flatMap((message) =>
    message.info.role === "assistant" && message.info.workflow ? [message.info.workflow] : [],
  )[0]
}

/**
 * The effort a build request ran at and who chose it, in order: the user's variant, the agent's variant or reasoning
 * options, the model's or provider's reasoning options, the user's own size or "think hard", a learned default, and
 * last the size's own effort.
 */
export function source(input: {
  readonly user: SessionV1.User
  readonly stepAgent: Agent.Info
  readonly model: Provider.Model
  readonly provider: Provider.Info
  readonly result: TaskSize.Result
  readonly effortTier: TaskSize.Tier
  readonly workflow?: Workflow
}): { readonly effort: string; readonly source: BrainWorkflow.EffortSource } {
  const sized = TaskSize.effort(input.effortTier)
  if (picked(input.user)) return { effort: input.user.model.variant!, source: "user" }
  if (input.stepAgent.variant || sets(input.stepAgent.options))
    return { effort: input.stepAgent.variant ?? "default", source: "agent" }
  if (sets(input.model.options) || sets(input.provider.options)) return { effort: sized, source: "config" }
  if (!automatic(input.result)) return { effort: sized, source: "explicit" }
  if (input.workflow?.effort) return { effort: input.workflow.effort, source: input.workflow.source }
  return { effort: sized, source: "size" }
}

/**
 * Whether the provider's small model costs strictly less than the parent's on every price, both priced: only then is
 * moving a subagent to it a saving.
 */
export function cheaper(small: Provider.Model | undefined, parent: Provider.Model | undefined) {
  return Boolean(
    small &&
      parent &&
      small.id !== parent.id &&
      small.capabilities.toolcall &&
      !small.cost.unpriced &&
      !parent.cost.unpriced &&
      small.cost.input <= parent.cost.input &&
      small.cost.output <= parent.cost.output &&
      small.cost.input + small.cost.output < parent.cost.input + parent.cost.output,
  )
}

/** Whether options set reasoning or thinking, at the top level or under a provider's key. */
export function sets(options: Record<string, unknown> | undefined) {
  return Object.entries(options ?? {}).some(
    ([key, value]) =>
      EFFORT_KEYS.includes(key) || (isRecord(value) && Object.keys(value).some((inner) => EFFORT_KEYS.includes(inner))),
  )
}

// The size came from Vector's rules: not the user's pick, "think hard", "no subagents" or "don't be thorough".
function automatic(result: TaskSize.Result) {
  return (
    result.source !== "user" &&
    !result.reasons.some(
      (reason) => reason.startsWith("explicit:") || reason === "capped" || reason === TaskSize.CAPPED_THOROUGH,
    )
  )
}

function picked(user: SessionV1.User) {
  return user.model.variant !== undefined && user.model.variant !== "default"
}

// How many subagents a task call launched: a batch's briefs, or one.
function launches(part: SessionV1.ToolPart) {
  const tasks = part.state.input.tasks
  return Array.isArray(tasks) ? tasks.length : 1
}

// The models a task call ran its general subagents on, one per such launch that got one, as "provider/model". A model
// the brief named is the agent's pick, not a default, so it teaches nothing (5.E.1).
function models(part: SessionV1.ToolPart) {
  if (part.state.status === "pending") return []
  const metadata = part.state.metadata ?? {}
  const runs = Array.isArray(metadata.tasks) ? metadata.tasks : [metadata]
  return runs.flatMap((item: unknown) =>
    isRecord(item) &&
    item.agent === GENERAL_SUBAGENT &&
    item.modelSource !== "call" &&
    isRecord(item.model) &&
    typeof item.model.providerID === "string"
      ? [`${item.model.providerID}/${String(item.model.modelID)}`]
      : [],
  )
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    BrainWorkflow.node,
    Brain.node,
    Config.node,
    RuntimeFlags.node,
    Provider.node,
    Instruction.node,
    Session.node,
    FreeModelGuests.node,
  ],
})
