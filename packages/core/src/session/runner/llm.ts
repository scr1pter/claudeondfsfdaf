export * as SessionRunnerLLM from "./llm"

import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  SystemPart,
  isContextOverflowFailure,
  type ProviderErrorEvent,
} from "@vectordevai/llm"
import { Cause, DateTime, Effect, FiberSet, Layer, Option, Semaphore, Stream } from "effect"
import { Billing } from "@vectordevai/schema/billing"
import { and, desc, eq, inArray } from "drizzle-orm"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { QuestionV2 } from "../../question"
import { SystemContext } from "../../system-context/index"
import { SystemContextRegistry } from "../../system-context/registry"
import { SkillGuidance } from "../../skill/guidance"
import { ReferenceGuidance } from "../../reference/guidance"
import { ToolRegistry } from "../../tool/registry"
import { ToolOutputStore } from "../../tool-output-store"
import { SessionContextEpoch } from "../context-epoch"
import { SessionCompaction } from "../compaction"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionMessage } from "../message"
import { TaskSize } from "../../task-size"
import { SessionInput } from "../input"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionMessageTable } from "../sql"
import { internalSessionPermissions } from "../permission"
import { type RunError, Service } from "./index"
import { SessionRunnerModel } from "./model"
import { codiumError } from "./model-plan-route"
import { createLLMEventPublisher } from "./publish-llm-event"
import { toLLMMessages } from "./to-llm-message"
import { MAX_STEPS_PROMPT } from "./max-steps"
import { Snapshot } from "../../snapshot"
import { SpendGuard } from "../../spend-guard"
import { ResearchPlan } from "../../research/plan"
import { makeLocationNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"

/**
 * Runs one durable coding-agent Session until it settles.
 *
 * Keep this as orchestration over smaller collaborators rather than rebuilding the legacy
 * `SessionPrompt` monolith. Implement the unchecked items in small reviewed slices:
 *
 * - Session ownership and controls
 *   - [x] Coordinate one local active drain per Session; explicit resumes join and prompt wakeups coalesce.
 *   - [ ] Replace local ownership with durable multi-node ownership when clustered.
 *   - [ ] Mark busy, retrying, idle, interrupted, or terminal-failure status durably.
 *   - [ ] Honor interruption and reject stale work after runtime attachment replacement.
 *   - [x] Honor optional agent step limits.
 *   - [x] Stop a guarded run at its spend, step, or unpriced-step limit before the next provider turn.
 *   - [ ] Record compaction model calls with the spend guard; a compaction's cost is not counted against the cap.
 *   - [ ] Apply the user's budget.run config to runs; only a prompt's own budget arms a V2 run today.
 *   - [ ] Bound provider retries and repeated identical tool calls.
 *
 * - Runtime context assembly
 *   - Track V1 runtime-context parity canonically in `specs/v2/session.md`.
 *
 * - One provider turn
 *   - [x] Translate every projected V2 Session message variant into canonical
 *     `@vectordevai/llm` messages.
 *   - [ ] Resolve policy-filtered built-in, MCP, plugin, and structured-output tool definitions.
 *   - [x] Stream exactly one `llm.stream(request)` provider turn.
 *   - [x] Persist assistant text and usage events incrementally as they arrive.
 *   - [ ] Persist snapshots, patches, and retry notices incrementally as they arrive.
 *   - [x] Persist reasoning, provider errors, and tool-call events incrementally as they arrive.
 *
 * - Tool settlement and continuation
 *   - [x] Durably record each tool call before side effects begin.
 *   - [x] Authorize and execute recorded local calls through a core-owned registry hook.
 *   - [x] Persist typed success, failure, and provider-executed tool outcomes.
 *   - [x] Start each recorded local call eagerly and await all settlements before continuation.
 *   - [ ] Add scoped runtime context, progress updates, attachment normalization,
 *     plugins, and cancellation settlement.
 *   - [x] Reload projected history and start the next explicit provider turn after local tool results.
 *   - [x] Continue for durable user steering accepted during an active provider turn.
 *   - [ ] Continue for compaction or another continuation condition when required.
 *
 * - Post-run maintenance
 *   - [ ] Settle final status and expose durable output events to replayable consumers.
 *   - [ ] Coalesce streamed deltas and add covering projected-history indexes.
 *   - [ ] Update title, summaries, compaction state, and cleanup in bounded background work.
 *
 * Use `llm.stream(request)` for each provider turn. Keep tool execution and continuation here.
 * Durable continuation recovery remains a separate future slice with an explicit retry policy.
 *
 * The current slice loads V2 history, translates it, resolves a model through a core service, and persists one
 * provider turn. Registry definitions are advertised, local tool calls are settled durably, and an
 * explicit loop starts the next provider turn after local settlement. Configured agent step limits bound the loop.
 */

// The most output a step asks for, as the V1 engine's OUTPUT_TOKEN_MAX.
const MAX_OUTPUT_TOKENS = 32_000

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const agents = yield* AgentV2.Service
    const tools = yield* ToolRegistry.Service
    const models = yield* SessionRunnerModel.Service
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const systemContext = yield* SystemContextRegistry.Service
    const skillGuidance = yield* SkillGuidance.Service
    const referenceGuidance = yield* ReferenceGuidance.Service
    const config = yield* Config.Service
    const snapshots = yield* Snapshot.Service
    const guard = yield* SpendGuard.Service
    const db = (yield* Database.Service).db
    const compaction = SessionCompaction.make({ events, llm, config: yield* config.entries() })
    const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })

    const getContext = Effect.fn("SessionRunner.getContext")(function* (sessionID: SessionSchema.ID) {
      return yield* store.context(sessionID)
    })
    // The agent the newest promoted prompt named, unless the session switched agent after it. A prompt that named none
    // is answered by the session's own agent, as a V1 message without one is by the default agent.
    const latestAgent = Effect.fn("SessionRunner.latestAgent")(function* (session: SessionSchema.Info) {
      const latest = yield* db
        .select({ type: SessionMessageTable.type, data: SessionMessageTable.data })
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, session.id),
            inArray(SessionMessageTable.type, ["user", "agent-switched"]),
          ),
        )
        .orderBy(desc(SessionMessageTable.seq))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      return latest?.type === "user" && "agent" in latest.data && typeof latest.data.agent === "string"
        ? latest.data.agent
        : session.agent
    })
    // A prompt's agent is the caller's word, and config may disable or remove an agent after a prompt named it, so an
    // agent this location does not have answers nothing: the session's own agent answers instead.
    const selectAgent = Effect.fn("SessionRunner.selectAgent")(function* (
      session: SessionSchema.Info,
      named: string | undefined,
    ) {
      const selected = yield* agents.select(named, session.internal !== undefined)
      return selected.info || named === session.agent ? selected : yield* agents.select(session.agent, session.internal !== undefined)
    })
    const failInterruptedTools = Effect.fn("SessionRunner.failInterruptedTools")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* getContext(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "pending" && tool.state.status !== "running")) continue
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID,
            timestamp: yield* DateTime.now,
            assistantMessageID: message.id,
            callID: tool.id,
            error: { type: "unknown", message: "Tool execution interrupted" },
            provider: {
              executed: tool.provider?.executed === true,
              ...(tool.provider?.metadata === undefined ? {} : { metadata: tool.provider.metadata }),
            },
          })
        }
      }
    })

    const awaitToolFibers = (fibers: FiberSet.FiberSet<void, ToolOutputStore.Error>) =>
      Effect.raceFirst(FiberSet.join(fibers), FiberSet.awaitEmpty(fibers))

    // Match V1: dismissing a question halts the loop instead of becoming model-facing tool output.
    const isQuestionRejected = (cause: Cause.Cause<unknown>) =>
      cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect instanceof QuestionV2.RejectedError)

    type TurnTransition =
      // Automatic compaction completed; rebuild the request from compacted history.
      | { readonly _tag: "ContinueAfterCompaction"; readonly step: number }
      // Overflow compaction completed; rebuild once through the path without overflow recovery.
      | { readonly _tag: "ContinueAfterOverflowCompaction"; readonly step: number }

    class TurnTransitionError extends Error {
      constructor(readonly transition: TurnTransition) {
        super()
      }
    }

    const continueAfterCompaction = (step: number) => new TurnTransitionError({ _tag: "ContinueAfterCompaction", step })
    const continueAfterOverflowCompaction = (step: number) =>
      new TurnTransitionError({ _tag: "ContinueAfterOverflowCompaction", step })

    const loadSystemContext = (agent: AgentV2.Selection) =>
      Effect.all([systemContext.load(), skillGuidance.load(agent), referenceGuidance.load()], {
        concurrency: "unbounded",
      }).pipe(Effect.map(SystemContext.combine))

    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      recoverOverflow?: typeof compaction.compactAfterOverflow,
    ) {
      const session = yield* getSession(sessionID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      // A prompt names the agent that answers it, so the turn runs under the agent of the newest prompt this boundary
      // promotes, or of the newest one already promoted. It is read before the context epoch starts, so a session's
      // first turn starts with its agent's own skills.
      const cutoff = yield* EventV2.latestSequence(db, session.id)
      const promoting = promotion ? yield* SessionInput.promotable(db, session.id, promotion, cutoff) : []
      const newest = promoting.at(-1)
      const agent = yield* selectAgent(
        session,
        newest ? (newest.prompt.agent ?? session.agent) : yield* latestAgent(session),
      )
      // Deep research's default caps hold a root run that has no cap of the owner's own (section 11.2), as on the V1
      // runner. This runner researches Focused only. A budget the owner armed keeps its place.
      if (agent.id === AgentV2.researchID && (yield* guard.rootOf(session.id)) === session.id)
        yield* guard.replaceFallback(
          session.id,
          ResearchPlan.budget(
            ResearchPlan.limits(ResearchPlan.settings(yield* config.entries(), config.scope), "focused"),
          ),
        )
      const initialized = yield* SessionContextEpoch.initialize(db, loadSystemContext(agent), session.id)
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      let needsContinuation = false
      let currentStep = step
      if (promotion) {
        let promoted = 0
        if (promotion === "steer") promoted = yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        if (promotion === "queue") {
          promoted += Number(yield* SessionInput.promoteNextQueued(db, events, session.id))
          promoted += yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        }
        if (promoted > 0) currentStep = 1
      }
      const system =
        initialized ?? (yield* SessionContextEpoch.prepare(db, events, loadSystemContext(agent), session.id))
      const model = yield* models.resolve(session)
      const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
      const context = entries.map((entry) => entry.message)
      const isLastStep = agent.info?.steps !== undefined && currentStep >= agent.info.steps
      const toolMaterialization = isLastStep
        ? undefined
        : yield* tools.materialize(
            agent.info?.permissions ?? [],
            internalSessionPermissions(session.internal),
            AgentV2.reserved(agent),
            ResearchPlan.withheld(),
          )
      // Each turn sizes the request it answers from the projected history, as the V1 runner does: a greeting is offered
      // no tools and any other request every tool. V2 has no subagents or judge, so no size brings them in. Vector's
      // own helper sessions keep every tool they were given.
      const size = session.internal ? undefined : requestSize(context)
      const withheld = size ? TaskSize.withheld(size.tier, size.agents.length) : new Set<string>()
      const definitions =
        size?.tier === "chat"
          ? []
          : (toolMaterialization?.definitions ?? []).filter((definition) => !withheld.has(definition.name))
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      const output = model.route.defaults.limits?.output
      const request = LLM.request({
        model,
        providerOptions: { openai: { promptCacheKey } },
        // As in the V1 engine, a step asks for at most 32K tokens of output. Reserving a catalog limit that equals the
        // context window would leave no room for input, and compaction would run before every step.
        ...(output ? { generation: { maxTokens: Math.min(output, MAX_OUTPUT_TOKENS) } } : {}),
        // Breakpoints on the tools, the system prompt and the conversation's tail, so each step of a tool loop reads
        // the steps before it from the cache. A breakpoint only on the user's prompt re-sends every tool call and
        // result after it at the full input price on every step.
        cache: { tools: true, system: true, messages: { tail: 2 } },
        system: [agent.info?.system, system.baseline]
          .filter((part): part is string => part !== undefined && part.length > 0)
          .map(SystemPart.make),
        messages: [...toLLMMessages(context, model), ...(isLastStep ? [Message.assistant(MAX_STEPS_PROMPT)] : [])],
        tools: definitions,
        toolChoice: isLastStep ? "none" : undefined,
      })
      if (yield* compaction.compactIfNeeded({ sessionID: session.id, entries, model, request }))
        return yield* Effect.die(continueAfterCompaction(currentStep))
      const startSnapshot = yield* snapshots.capture()
      const publisher = createLLMEventPublisher(events, {
        sessionID: session.id,
        agent: agent.id,
        model: {
          id: ModelV2.ID.make(model.id),
          providerID: ProviderV2.ID.make(model.provider),
          ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
        },
        snapshot: startSnapshot,
      })
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
        withPublication(publisher.publish(event, outputPaths))
      let overflowFailure: ProviderErrorEvent | undefined
      const providerStream = llm.stream(request).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (overflowFailure || publisher.hasProviderError()) return
            if (LLMEvent.is.providerError(event)) {
              if (isContextOverflowFailure(event) && !publisher.hasAssistantStarted()) {
                overflowFailure = event
                return
              }
            }
            yield* publish(event)
            if (event.type !== "tool-call" || event.providerExecuted) return
            if (!toolMaterialization) {
              yield* withPublication(publisher.failUnsettledTools("Tools are disabled after the maximum agent steps"))
              return
            }
            needsContinuation = true
            const assistantMessageID = yield* publisher.assistantMessageID(event.id)
            yield* Effect.uninterruptibleMask((restore) =>
              restore(
                toolMaterialization.settle({
                  sessionID: session.id,
                  agent: agent.id,
                  assistantMessageID,
                  call: event,
                }),
              ).pipe(
                Effect.flatMap((settlement) =>
                  publish(
                    LLMEvent.toolResult({
                      id: event.id,
                      name: event.name,
                      result: settlement.result,
                      output: settlement.output,
                    }),
                    settlement.outputPaths ?? [],
                  ),
                ),
              ),
            ).pipe(FiberSet.run(toolFibers))
          }),
        ),
        Effect.ensuring(withPublication(publisher.flush())),
      )

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const stream = yield* restore(providerStream).pipe(Effect.exit)
          const failure =
            stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
          if (
            recoverOverflow &&
            !publisher.hasAssistantStarted() &&
            isContextOverflowFailure(overflowFailure ?? failure) &&
            (yield* restore(recoverOverflow({ sessionID: session.id, entries, model, request })))
          )
            return yield* Effect.die(continueAfterOverflowCompaction(currentStep))
          if (overflowFailure) yield* publish(overflowFailure)
          const llmFailure = failure instanceof LLMError ? failure : undefined
          if (llmFailure && !publisher.hasProviderError()) {
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
            yield* withPublication(
              publisher.failAssistant(
                llmFailure.reason._tag === "FreeModelsLimit"
                  ? llmFailure.reason.limit
                  : (codiumError(llmFailure) ?? llmFailure.reason.message),
              ),
            )
          }
          if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) yield* FiberSet.clear(toolFibers)
          // The provider bills a step once it reports usage, so every way out of the turn records it, and the spend
          // guard counts it: a step that fails after the provider settled it was still billed.
          const settleStep = Effect.gen(function* () {
            const stepSettlement = publisher.stepSettlement()
            if (!stepSettlement) return undefined
            if (llmFailure || publisher.hasProviderError()) {
              yield* guard.record(
                session.id,
                SessionRunnerModel.spendStep(model, stepSettlement, { continues: false, patched: false }),
              )
              return undefined
            }
            const endSnapshot = yield* snapshots.capture()
            const files =
              startSnapshot && endSnapshot
                ? yield* snapshots
                    .files({ from: startSnapshot, to: endSnapshot })
                    .pipe(Effect.catch(() => Effect.succeed(undefined)))
                : undefined
            const tokens = stepSettlement.tokens
            const spend = SessionRunnerModel.spendStep(model, stepSettlement, {
              continues: needsContinuation,
              patched: Boolean(files?.length),
            })
            // A step that used no tokens owes nothing whatever the model charges.
            const used = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
            yield* withPublication(
              events.publish(SessionEvent.Step.Ended, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: yield* publisher.startAssistant(),
                finish: stepSettlement.finish,
                // The durable event keeps a finite cost, so an unknown price is recorded as 0 and marked unpriced:
                // readers then tell it apart from a free model instead of counting it as measured free spend. A Vector
                // Codium step is billed to the account's plan on vectordev.ai, so it is never priced here, whatever
                // the provider metadata reports.
                ...(Billing.isCodium(model.provider)
                  ? { cost: 0, unpriced: true, billing: "codium" as const }
                  : {
                      cost: spend.costUsd ?? 0,
                      ...(spend.costUsd === undefined && used > 0 ? { unpriced: true } : {}),
                    }),
                tokens,
                snapshot: endSnapshot,
                files,
              }),
            )
            return yield* guard.record(session.id, spend)
          })
          const settled = yield* restore(awaitToolFibers(toolFibers)).pipe(Effect.exit)
          if (settled._tag === "Failure" && isQuestionRejected(settled.cause)) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            yield* settleStep
            return yield* Effect.interrupt
          }
          if (
            (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) ||
            (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
          ) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            if (publisher.hasActiveAssistant())
              yield* withPublication(publisher.failAssistant("Provider turn interrupted"))
          }
          if (settled._tag === "Failure" && !Cause.hasInterrupts(settled.cause)) {
            const failure = Cause.squash(settled.cause)
            const message = failure instanceof Error ? failure.message : String(failure)
            yield* withPublication(publisher.failUnsettledTools(`Tool execution failed: ${message}`))
          }
          const verdict = yield* settleStep
          if (verdict?.state === "stopped") {
            // The step's answer is final when nothing follows it; only a cut-short continuation says why on the
            // message. Step.Failed after Step.Ended keeps the step's cost and tokens and marks it an error.
            if (needsContinuation) yield* withPublication(publisher.failAssistant(verdict.message))
            needsContinuation = false
          }
          if (publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
          if (stream._tag === "Success" && !publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
          if (stream._tag === "Failure") return yield* Effect.failCause(stream.cause)
          if (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
            return yield* Effect.failCause(settled.cause)
          return { needsContinuation: !publisher.hasProviderError() && needsContinuation, step: currentStep }
        }),
      )
    }, Effect.scoped)
    type RunTurn = (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
    ) => Effect.Effect<{ readonly needsContinuation: boolean; readonly step: number }, RunError>

    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step) {
      return yield* runTurnAttempt(sessionID, promotion, step).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
            yield* Effect.yieldNow
            return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step)
          }),
        ),
      )
    })

    const runTurn: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step) {
      return yield* runTurnAttempt(sessionID, promotion, step, compaction.compactAfterOverflow).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            yield* Effect.yieldNow
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step)
            return yield* runTurn(sessionID, undefined, defect.transition.step)
          }),
        ),
      )
    })

    const run = Effect.fn("SessionRunner.run")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
    }) {
      const hasSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
      const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
      if (!input.force && !hasSteer && !hasQueue) return
      yield* failInterruptedTools(input.sessionID)
      // A drain is one guarded run. A linked subagent's steps are charged to its root's run whichever drain begins
      // it, so only the root begins and ends one: a subagent would otherwise hold an empty run of its own and push
      // a stray finished run into the guard's bounded history.
      const owner = (yield* guard.rootOf(input.sessionID)) === input.sessionID
      // Inputs left pending by a stop stay durable and drain under a fresh run, which keeps the stopped run's cap
      // unless a new budget was armed. That drain often starts at once: a prompt admitted during the stopped turn
      // wakes a successor drain, and a budget armed then landed on the stopped run. A cap the owner armed stays the
      // owner's in the successor, so research's default caps do not replace it.
      const previous = owner ? yield* guard.snapshot(input.sessionID) : undefined
      if (owner) yield* guard.begin(input.sessionID, undefined, previous?.stopped ? previous : undefined)
      yield* Effect.gen(function* () {
        let promotion: SessionInput.Delivery | undefined = hasSteer ? "steer" : hasQueue ? "queue" : undefined
        let shouldRun = input.force || hasSteer || hasQueue
        while (shouldRun) {
          let needsContinuation = true
          let step = 1
          while (needsContinuation) {
            // Every provider turn starts here, including the ones re-armed by pending steer or queued input, so a
            // stopped run (or a stopped root, for a subagent) never starts another.
            if (yield* guard.stopped(input.sessionID)) return
            const result = yield* runTurn(input.sessionID, promotion, step)
            needsContinuation = result.needsContinuation
            step = result.step + 1
            promotion = "steer"
            if (!needsContinuation) needsContinuation = yield* SessionInput.hasPending(db, input.sessionID, "steer")
          }
          shouldRun = yield* SessionInput.hasPending(db, input.sessionID, "queue")
          promotion = shouldRun ? "queue" : undefined
        }
      }).pipe(Effect.ensuring(owner ? guard.end(input.sessionID) : Effect.void))
    })

    return Service.of({
      run,
    })
  }),
)

// The size of the request a turn answers, folded over the user's messages oldest first as the V1 history fold does.
// Each message is read against the work before it (the last message that was not Chat) and the reply that answered the
// message before it, so a "thanks" while the agent waits on an answer, or a "build it" after a plan from Plan mode,
// continues that work instead of becoming a bare reply.
function requestSize(context: readonly SessionMessage.Message[]) {
  const users = context.flatMap((message, index) => (message.type === "user" ? [{ message, index }] : []))
  // A compaction summarised what came before, so a "continue" after it has work of unknown size to go on with.
  const compacted = context.some((message) => message.type === "compaction")
  return users.reduce<{ result?: TaskSize.Result; work?: TaskSize.Tier; plan: boolean }>(
    (state, user, position) => {
      const reply =
        position === 0
          ? []
          : context
              .slice(users[position - 1]!.index + 1, user.index)
              .filter((message): message is SessionMessage.Assistant => message.type === "assistant")
      const text = reply
        .flatMap((message) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])))
        .join("\n")
      const last = reply.at(-1)
      // The reply to a message that was more than a greeting is the work's: a plan when it came from Plan mode.
      const plan = state.result && state.result.tier !== "chat" ? last?.agent === "plan" : state.plan
      const result = TaskSize.classify({
        text: user.message.text,
        files: user.message.files?.filter((file) => !file.mime.startsWith("image/")).length,
        images: user.message.files?.filter((file) => file.mime.startsWith("image/")).length,
        agents: user.message.agents?.map((agent) => agent.name),
        previous: state.work,
        // The work before is still open when its reply asked the user a question, the user dismissed the question
        // tool, or its run did not finish (a message that joined a running drain has no reply of its own yet). A
        // greeting's reply is never open.
        open:
          position > 0 &&
          state.result?.tier !== "chat" &&
          (TaskSize.asks(text) ||
            !last ||
            last.error !== undefined ||
            UNFINISHED.has(last.finish ?? "") ||
            reply.some(dismissed)),
        plan,
      })
      return { result, work: result.tier === "chat" ? state.work : result.tier, plan }
    },
    { work: compacted ? "standard" : undefined, plan: false },
  ).result
}

// Finish reasons of a step that stopped before its answer was done.
const UNFINISHED = new Set(["length", "tool-calls", "unknown", "error", "content-filter"])

// A step that asked through the question tool and got no answer: the user dismissed it, or has not answered yet.
function dismissed(message: SessionMessage.Assistant) {
  return message.content.some(
    (part) => part.type === "tool" && part.name === "question" && part.state.status !== "completed",
  )
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    llmClient,
    AgentV2.node,
    ToolRegistry.node,
    SessionRunnerModel.node,
    SessionStore.node,
    Location.node,
    SystemContextRegistry.node,
    SkillGuidance.node,
    ReferenceGuidance.node,
    Config.node,
    Snapshot.node,
    Database.node,
    SpendGuard.node,
  ],
})
