import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { createHash } from "node:crypto"
import { PermissionV1 } from "@vectordevai/core/v1/permission"
import { Image } from "@/image/image"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Context, Scope, Schema } from "effect"
import * as Stream from "effect/Stream"
import { asSchema, type Tool } from "ai"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import { Session } from "./session"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { isOverflow, refusal } from "./overflow"
import { SystemPrompt } from "./system"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionAdmission } from "./admission"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { errorMessage } from "@/util/error"
import { NamedError } from "@vectordevai/core/util/error"
import { isRecord } from "@/util/record"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@vectordevai/core/database/database"
import { Usage, type LLMEvent } from "@vectordevai/llm"
import { EffectBridge } from "@/effect/bridge"
import { NativePatch } from "./llm/native-patch"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { NEXT_STEP_SLACK } from "@vectordevai/core/review/plan"
import { providerCredentialAllowed, providerUsable } from "@vectordevai/core/provider-policy"
import { isFreeModel } from "@vectordevai/schema/free-model"
import { Auth } from "@/auth"
import { ModelSlots } from "@vectordevai/core/local-mode/model-slots"
import { LocalErrors } from "@vectordevai/core/local-mode/errors"
import { Token } from "@vectordevai/core/util/token"
import { POLLING_ACTIONS, TerminalTool } from "@/tool/terminal"

const DOOM_LOOP_THRESHOLD = 3
// Tools that change files. Without a snapshot to diff, a successful call to one of these counts as a file change for
// the spend guard's loop rules.
const FILE_TOOLS = new Set(["edit", "write", "apply_patch"])
export type Result = "compact" | "stop" | "continue"

export interface Handle {
  readonly message: SessionV1.Assistant
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
  ) => Effect.Effect<SessionV1.ToolPart | undefined>
  readonly completeToolCall: (
    toolCallID: string,
    output: {
      title: string
      metadata: Record<string, any>
      output: string
      attachments?: SessionV1.FilePart[]
    },
  ) => Effect.Effect<void>
  readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
}

type Input = {
  assistantMessage: SessionV1.Assistant
  sessionID: SessionID
  model: Provider.Model
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Handle>
  // Waits for the session's snapshot work: the closing snapshot, patch and step-finish snapshot of its steps.
  readonly settle: (sessionID: SessionID) => Effect.Effect<void>
}

type ToolCall = {
  partID: SessionV1.ToolPart["id"]
  messageID: SessionV1.ToolPart["messageID"]
  sessionID: SessionV1.ToolPart["sessionID"]
  done: Deferred.Deferred<void>
}

interface ProcessorContext extends Input {
  toolcalls: Record<string, ToolCall>
  shouldBreak: boolean
  snapshot: string | undefined
  // The opening snapshot while it is still being taken.
  opening: Fiber.Fiber<string | undefined> | undefined
  blocked: boolean
  // The tool calls of the current provider step, for the spend guard's loop rules.
  stepTools: {
    callID: string
    tool: string
    input: string
    output?: string
    error?: string
    providerExecuted: boolean
  }[]
  needsCompaction: boolean
  currentText: SessionV1.TextPart | undefined
  reasoningMap: Record<string, SessionV1.ReasoningPart>
  // What the provider reported as it started the current step, until the step's own usage replaces it.
  started: Usage | undefined
}

type StreamEvent = LLMEvent

export class Service extends Context.Service<Service, Interface>()("@vector/SessionProcessor") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const snapshot = yield* Snapshot.Service
    const agents = yield* Agent.Service
    const llm = yield* LLM.Service
    const permission = yield* Permission.Service
    const plugin = yield* Plugin.Service
    const summary = yield* SessionSummary.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service
    const image = yield* Image.Service
    const events = yield* EventV2Bridge.Service
    const database = yield* Database.Service
    const auth = yield* Auth.Service
    const guard = yield* SpendGuard.Service
    const provider = yield* Provider.Service
    const slots = yield* ModelSlots.Service
    // The user message each root session last answered, so its first step for a new prompt drops waiting helpers.
    const prompts = new Map<SessionID, string>()

    // A session's snapshot work runs in order and off the request path: each piece starts after the one before it, so
    // the closing snapshot and patch of one step land before the next step's opening snapshot. Every tool call waits
    // for the work queued so far (see `gate`), so tools still never run before the snapshot of the state they change.
    const queues = new Map<SessionID, Fiber.Fiber<unknown>>()

    const enqueue = <A>(sessionID: SessionID, work: Effect.Effect<A>) =>
      Effect.gen(function* () {
        const previous = queues.get(sessionID)
        const fiber = yield* (previous ? Fiber.await(previous).pipe(Effect.andThen(work)) : work).pipe(
          Effect.forkIn(scope),
        )
        queues.set(sessionID, fiber)
        fiber.addObserver(() => {
          if (queues.get(sessionID) === fiber) queues.delete(sessionID)
        })
        return fiber
      })

    const settle = Effect.fn("SessionProcessor.settle")(function* (sessionID: SessionID) {
      while (true) {
        const fiber = queues.get(sessionID)
        if (!fiber) return
        yield* Fiber.await(fiber)
        if (queues.get(sessionID) === fiber) queues.delete(sessionID)
      }
    })

    const result = <A>(fiber: Fiber.Fiber<A | undefined>) =>
      Fiber.await(fiber).pipe(Effect.map((exit) => (Exit.isSuccess(exit) ? exit.value : undefined)))

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // The opening snapshot is taken while the request is built and sent rather than before it. The AI SDK may run
      // tools before it emits start-step, so tools are held until it lands instead (see `gate` in process).
      const opening = yield* enqueue(input.sessionID, snapshot.track())
      // The line this model's requests wait in at its server, read the way the provider holds them, so every request
      // that waits in it is named: the user's turn, or a subagent's in a child session. On a server someone hosts the
      // agent also needs its fixed prompt to fit, and its errors come with their fix. A cloud API with no configured
      // `concurrency` has no line and skips all of it.
      const line = yield* provider.line(input.model)
      const hosted = line?.hosted ? line.origin : undefined
      const parentID = line
        ? yield* session.get(input.sessionID).pipe(
            Effect.map((info) => info.parentID),
            Effect.catch(() => Effect.succeed(undefined)),
          )
        : undefined
      // The first step for a new prompt in a root session: helpers still waiting for a server can wait for the next.
      if (line && !parentID && prompts.get(input.sessionID) !== input.assistantMessage.parentID) {
        prompts.delete(input.sessionID)
        prompts.set(input.sessionID, input.assistantMessage.parentID)
        if (prompts.size > 500) prompts.delete(prompts.keys().next().value!)
        slots.prompted()
      }
      // How this model's steps count against a run budget. A plan, such as a ChatGPT plan, pays for them only when
      // the credential llm.ts actually sends is the stored OAuth sign-in, so this applies the same credential rule.
      // A server on this computer, or a private one on the model server list in effect (the user's or the company's,
      // without an edit still held for the owner), has no per-token price. The sign-in is read from disk while the
      // request is sent, off the request path.
      const costKind = yield* auth.get(input.model.providerID).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
        Effect.map((signIn) =>
          SpendGuard.costKindOf({
            free: isFreeModel(input.model) || input.model.freeModel !== undefined,
            oauthPlan:
              signIn?.type === "oauth" &&
              providerCredentialAllowed(
                input.model.providerID,
                signIn,
                providerUsable(input.model.providerID, { npm: input.model.api.npm, api: input.model.api.url }),
              ),
            listed: input.model.cost.input > 0 || input.model.cost.output > 0,
            local: line?.local ?? false,
          }),
        ),
        Effect.forkIn(scope),
      )
      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        toolcalls: {},
        shouldBreak: false,
        snapshot: undefined,
        opening,
        blocked: false,
        stepTools: [],
        needsCompaction: false,
        currentText: undefined,
        reasoningMap: {},
        started: undefined,
      }
      let aborted = false
      let attempt: SessionAdmission.Settlement | undefined
      let observe: SessionAdmission.Lease["observe"]

      const parse = (e: unknown) =>
        MessageV2.fromError(e, {
          providerID: input.model.providerID,
          aborted,
        })

      // The hash of the step's opening snapshot, taking one if this step has none yet.
      const opened = Effect.fnUntraced(function* () {
        if (ctx.snapshot) return ctx.snapshot
        const fiber = ctx.opening ?? (yield* enqueue(ctx.sessionID, snapshot.track()))
        ctx.opening = undefined
        ctx.snapshot = yield* result(fiber)
        return ctx.snapshot
      })

      // Records the files the step changed since its opening snapshot. Queued, so it reads the worktree before any
      // later step's tools can change it.
      // Whether the step changed a file, which the spend guard's loop rules also learn here.
      const recordPatch = (start: string) =>
        Effect.gen(function* () {
          const patch = yield* snapshot.patch(start)
          if (!patch.files.length) return false
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: ctx.assistantMessage.id,
            sessionID: ctx.sessionID,
            type: "patch",
            hash: patch.hash,
            files: patch.files,
          })
          yield* guard.changed(ctx.sessionID)
          return true
        })

      const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
        const done = ctx.toolcalls[toolCallID]?.done
        delete ctx.toolcalls[toolCallID]
        if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
      })

      const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return undefined
        const part = yield* session.getPart({
          partID: call.partID,
          messageID: call.messageID,
          sessionID: call.sessionID,
        })
        if (!part || part.type !== "tool") {
          delete ctx.toolcalls[toolCallID]
          return undefined
        }
        return { call, part }
      })

      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return undefined
        const part = yield* session.updatePart(update(match.part))
        ctx.toolcalls[toolCallID] = {
          ...match.call,
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return part
      })

      const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
        toolCallID: string,
        output: {
          title: string
          metadata: Record<string, any>
          output: string
          attachments?: SessionV1.FilePart[]
        },
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return
        // A digest of what the call returned, so the spend guard's loop rules can tell a repeat from a call that got
        // a new answer.
        const digest = createHash("sha256")
          .update([output.output, ...(output.attachments ?? []).map((attachment) => attachment.url)].join("\n"))
          .digest("hex")
        ctx.stepTools = ctx.stepTools.map((item) => (item.callID === toolCallID ? { ...item, output: digest } : item))
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "completed",
            input: match.part.state.input,
            output: output.output,
            metadata: output.metadata,
            title: output.title,
            time: { start: match.part.state.time.start, end: Date.now() },
            attachments: output.attachments,
          },
        })
        yield* settleToolCall(toolCallID)
      })

      const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return false
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "error",
            input: match.part.state.input,
            error: errorMessage(error),
            time: { start: match.part.state.time.start, end: Date.now() },
          },
        })
        if (error instanceof PermissionV1.RejectedError || error instanceof Question.RejectedError) {
          ctx.blocked = ctx.shouldBreak
        }
        ctx.stepTools = ctx.stepTools.map((item) =>
          item.callID === toolCallID ? { ...item, error: errorMessage(error) } : item,
        )
        yield* settleToolCall(toolCallID)
        return true
      })

      // Counts one provider step against the run of this session's root. A stop on a step that would continue ends
      // the turn with BudgetStopError. A stop on a final answer leaves the answer alone; the run's stopped flag still
      // halts the rest of the lineage at its next boundary.
      const recordStep = Effect.fn("SessionProcessor.recordStep")(function* (
        step: {
          costUsd: number
          unpriced: boolean
          tokens: SessionV1.Assistant["tokens"]
          continues: boolean
          patched: boolean
        },
        confirm?: Effect.Effect<boolean>,
      ) {
        const tools = ctx.stepTools
        ctx.stepTools = []
        const kind = (yield* result(costKind)) ?? "unknown"
        const contextTokens = step.tokens.input + step.tokens.cache.read + step.tokens.cache.write
        // The next step is estimated at the rates its context will be billed at, a long-context tier included.
        const rates = Session.costAt(input.model.cost, contextTokens + NEXT_STEP_SLACK)
        const verdict = yield* guard.record(
          ctx.sessionID,
          {
            costUsd: step.costUsd,
            // A model the catalog lists no price for is still priced when its provider reported what the step cost.
            costKind: kind === "unknown" && step.costUsd > 0 && !step.unpriced ? "priced" : kind,
            price: rates && SpendGuard.priceOf(rates),
            contextTokens,
            cachedTokens: step.tokens.cache.read,
            continues: step.continues,
            tools: (yield* config.get()).budget?.loop?.enabled === false ? [] : tools,
            patched: step.patched,
          },
          confirm,
        )
        if (verdict.state !== "stopped" || !step.continues) return
        yield* stopTurn(verdict)
      })

      // Ends this turn with the reason the spend guard stopped its run.
      const stopTurn = Effect.fn("SessionProcessor.stopTurn")(function* (
        stop: SpendGuard.Stop & { readonly estimate?: SpendGuard.Estimate },
      ) {
        const run = yield* guard.snapshot(ctx.sessionID)
        ctx.assistantMessage.error = new SessionV1.BudgetStopError({
          reason: stop.reason,
          message: stop.message,
          spentUsd: run?.spentUsd,
          capUsd: run?.budget.usd,
          unpricedSteps: run?.unpricedSteps,
          estimate: stop.estimate,
        }).toObject()
        ctx.blocked = true
        yield* session.updateMessage(ctx.assistantMessage)
      })

      const finishReasoning = Effect.fn("SessionProcessor.finishReasoning")(function* (reasoningID: string) {
        if (!(reasoningID in ctx.reasoningMap)) return
        // oxlint-disable-next-line no-self-assign -- reactivity trigger
        ctx.reasoningMap[reasoningID].text = ctx.reasoningMap[reasoningID].text
        ctx.reasoningMap[reasoningID].time = { ...ctx.reasoningMap[reasoningID].time, end: Date.now() }
        yield* session.updatePart(ctx.reasoningMap[reasoningID])
        delete ctx.reasoningMap[reasoningID]
      })

      const ensureToolCall = Effect.fn("SessionProcessor.ensureToolCall")(function* (input: {
        id: string
        name: string
        providerExecuted?: boolean
      }) {
        const existing = yield* readToolCall(input.id)
        if (existing) {
          if (!input.providerExecuted || existing.part.metadata?.providerExecuted) return existing
          const part = yield* session.updatePart({
            ...existing.part,
            metadata: { ...existing.part.metadata, providerExecuted: true },
          })
          ctx.toolcalls[input.id] = {
            ...existing.call,
            partID: part.id,
            messageID: part.messageID,
            sessionID: part.sessionID,
          }
          return { call: ctx.toolcalls[input.id], part }
        }
        const part = yield* session.updatePart({
          id: PartID.ascending(),
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.assistantMessage.sessionID,
          type: "tool",
          tool: input.name,
          callID: input.id,
          state: { status: "pending", input: {}, raw: "" },
          metadata: input.providerExecuted ? { providerExecuted: true } : undefined,
        } satisfies SessionV1.ToolPart)
        ctx.toolcalls[input.id] = {
          done: yield* Deferred.make<void>(),
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return { call: ctx.toolcalls[input.id], part }
      })

      const isFilePart = (value: unknown): value is SessionV1.FilePart => Schema.is(SessionV1.FilePart)(value)

      const toolResultOutput = (
        value: Extract<StreamEvent, { type: "tool-result" }>,
      ): { title: string; metadata: Record<string, any>; output: string; attachments?: SessionV1.FilePart[] } => {
        if (isRecord(value.result.value) && typeof value.result.value.output === "string") {
          return {
            title: typeof value.result.value.title === "string" ? value.result.value.title : value.name,
            metadata: isRecord(value.result.value.metadata) ? value.result.value.metadata : {},
            output: value.result.value.output,
            attachments: Array.isArray(value.result.value.attachments)
              ? value.result.value.attachments.filter(isFilePart)
              : undefined,
          }
        }
        return {
          title: value.name,
          metadata: value.result.type === "json" && isRecord(value.result.value) ? value.result.value : {},
          output:
            typeof value.result.value === "string" ? value.result.value : (JSON.stringify(value.result.value) ?? ""),
        }
      }

      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent) {
        switch (value.type) {
          case "reasoning-start":
            if (value.id in ctx.reasoningMap) return
            ctx.reasoningMap[value.id] = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "reasoning",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.reasoningMap[value.id])
            return

          case "reasoning-delta":
            // Match dev: silently drop orphan deltas (no preceding reasoning-start).
            if (!(value.id in ctx.reasoningMap)) return
            ctx.reasoningMap[value.id].text += value.text
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.reasoningMap[value.id].sessionID,
              messageID: ctx.reasoningMap[value.id].messageID,
              partID: ctx.reasoningMap[value.id].id,
              field: "text",
              delta: value.text,
            })
            return

          case "reasoning-end":
            if (value.providerMetadata && value.id in ctx.reasoningMap) {
              ctx.reasoningMap[value.id].metadata = value.providerMetadata
            }
            yield* finishReasoning(value.id)
            return

          case "tool-input-start":
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            yield* ensureToolCall(value)
            return

          case "tool-input-delta":
            yield* ensureToolCall(value)
            return

          case "tool-input-end": {
            yield* ensureToolCall(value)
            return
          }

          case "tool-call": {
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            const call = yield* ensureToolCall(value)
            const input = isRecord(value.input) ? value.input : { value: value.input }
            ctx.stepTools.push({
              callID: value.id,
              tool: value.name,
              input: JSON.stringify(input),
              providerExecuted: call.part.metadata?.providerExecuted === true,
            })
            yield* updateToolCall(value.id, (match) => ({
              ...match,
              tool: value.name,
              state:
                match.state.status === "running"
                  ? { ...match.state, input }
                  : {
                      status: "running",
                      input,
                      time: { start: Date.now() },
                    },
              metadata: match.metadata?.providerExecuted
                ? { ...value.providerMetadata, providerExecuted: true }
                : value.providerMetadata,
            }))

            // Polling a terminal repeats the same call while its output moves on: progress, not a loop.
            if (value.name === TerminalTool.id && POLLING_ACTIONS.has(String(input.action))) return

            const parts = yield* MessageV2.parts(ctx.assistantMessage.id).pipe(
              Effect.provideService(Database.Service, database),
            )
            const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)

            if (
              recentParts.length !== DOOM_LOOP_THRESHOLD ||
              !recentParts.every(
                (part) =>
                  part.type === "tool" &&
                  part.tool === value.name &&
                  part.state.status !== "pending" &&
                  JSON.stringify(part.state.input) === JSON.stringify(input),
              )
            ) {
              return
            }

            // A helper session's agent may be a Subagent specialist Settings turned off, which only `helper` finds.
            const internal = (yield* session.get(ctx.sessionID).pipe(Effect.orDie)).internal
            const agent = internal
              ? yield* agents.helper(ctx.assistantMessage.agent)
              : yield* agents.get(ctx.assistantMessage.agent)
            yield* permission.ask({
              permission: "doom_loop",
              patterns: [value.name],
              sessionID: ctx.assistantMessage.sessionID,
              metadata: { tool: value.name, input },
              always: [value.name],
              ruleset: agent.permission,
            })
            return
          }

          case "tool-result": {
            const toolCall = yield* readToolCall(value.id)
            if (!toolCall && value.result.type === "error") return
            if (value.result.type === "error") {
              yield* failToolCall(value.id, value.result.value)
              return
            }
            const rawOutput = toolResultOutput(value)
            const normalized = yield* Effect.forEach(rawOutput.attachments ?? [], (attachment) =>
              attachment.mime.startsWith("image/")
                ? image.normalize(attachment).pipe(
                    Effect.catchIf(
                      (error) => error instanceof Image.ResizerUnavailableError,
                      () => Effect.succeed(attachment),
                    ),
                    Effect.exit,
                  )
                : Effect.succeed(Exit.succeed<SessionV1.FilePart>(attachment)),
            )
            const omitted = normalized.filter(Exit.isFailure).length
            const attachments = normalized.filter(Exit.isSuccess).map((item) => item.value)
            const output = {
              ...rawOutput,
              output:
                omitted === 0
                  ? rawOutput.output
                  : `${rawOutput.output}\n\n[${omitted} image${omitted === 1 ? "" : "s"} omitted: could not be resized below the image size limit.]`,
              attachments: attachments.length ? attachments : undefined,
            }
            yield* completeToolCall(value.id, output)
            return
          }

          case "tool-error": {
            yield* failToolCall(value.id, value.error ?? new Error(value.message))
            return
          }

          case "provider-error":
            throw new Error(value.message)

          case "step-start":
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              snapshot: yield* opened(),
              type: "step-start",
            })
            return

          case "step-finish": {
            const usage = Session.getUsage({
              model: ctx.model,
              usage: value.usage ?? new Usage({}),
              metadata: value.providerMetadata,
            })
            if (attempt) {
              attempt = {
                usage: value.usage,
                cost: attempt.cost + usage.cost,
                context: usage.tokens.input + usage.tokens.cache.read + usage.tokens.cache.write,
                cached: usage.tokens.cache.read,
                complete:
                  Number.isFinite(value.usage?.totalTokens) &&
                  !["other", "error", "abort"].includes(value.reason) &&
                  !usage.unpriced,
              }
              observe?.(attempt.cost)
            }
            const stepFinish: SessionV1.StepFinishPart = {
              id: PartID.ascending(),
              reason: value.reason,
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "step-finish",
              tokens: usage.tokens,
              cost: usage.cost,
              ...(usage.unpriced ? { unpriced: true } : {}),
            }
            // The provider has billed this step, so its usage is recorded whole before the snapshot, which can wait
            // on the worktree's snapshot lock long enough for a cancel to land.
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                ctx.started = undefined
                ctx.assistantMessage.finish = value.reason
                ctx.assistantMessage.cost += usage.cost
                if (usage.unpriced) ctx.assistantMessage.unpriced = true
                ctx.assistantMessage.tokens = usage.tokens
                yield* session.updatePart(stepFinish)
                yield* session.updateMessage(ctx.assistantMessage)
              }),
            )
            yield* Effect.forEach(Object.keys(ctx.reasoningMap), finishReasoning)
            // The step is over once the provider's terminal event is recorded, so the loop moves on now. The closing
            // snapshot and the step's patch run in the session's snapshot queue, ahead of the next step's tools.
            const start = ctx.snapshot
            const opening = ctx.opening
            ctx.snapshot = undefined
            ctx.opening = undefined
            const work = yield* enqueue(
              ctx.sessionID,
              Effect.gen(function* () {
                const closing = yield* snapshot.track()
                if (closing) yield* session.updatePart({ ...stepFinish, snapshot: closing })
                const from = start ?? (opening ? yield* result(opening) : undefined)
                const changed = from ? yield* recordPatch(from) : false
                yield* summary
                  .summarize({
                    sessionID: ctx.sessionID,
                    messageID: ctx.assistantMessage.parentID,
                  })
                  .pipe(Effect.ignore, Effect.forkIn(scope))
                return changed
              }),
            )
            yield* recordStep(
              {
                costUsd: usage.cost,
                unpriced: usage.unpriced,
                tokens: usage.tokens,
                // The loop's own rule: it goes on after "tool-calls", and after local tool calls under any finish
                // reason. A StructuredOutput call is the final answer.
                continues:
                  (value.reason === "tool-calls" || ctx.stepTools.some((item) => !item.providerExecuted)) &&
                  !ctx.stepTools.some((item) => item.tool === "StructuredOutput"),
                // The step's patch is taken off the request path, so a successful edit tool stands in for it here.
                patched: ctx.stepTools.some((item) => FILE_TOOLS.has(item.tool) && item.error === undefined),
              },
              result(work).pipe(Effect.map((changed) => changed === true)),
            )
            if (
              !ctx.assistantMessage.summary &&
              isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
            ) {
              ctx.needsCompaction = true
            }
            return
          }

          case "text-start":
            ctx.currentText = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "text",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.currentText)
            return

          case "text-delta":
            if (!ctx.currentText) return
            ctx.currentText.text += value.text
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.currentText.sessionID,
              messageID: ctx.currentText.messageID,
              partID: ctx.currentText.id,
              field: "text",
              delta: value.text,
            })
            return

          case "text-end":
            if (!ctx.currentText) return
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.currentText.text = ctx.currentText.text
            ctx.currentText.text = (yield* plugin.trigger(
              "experimental.text.complete",
              {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                partID: ctx.currentText.id,
              },
              { text: ctx.currentText.text },
            )).text
            {
              const end = Date.now()
              ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            }
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePart(ctx.currentText)
            ctx.currentText = undefined
            return

          case "finish":
            return
        }
      })

      // A step the provider started billing but that never finished, because it was stopped or failed mid-stream, gets
      // no usage of its own, so it is recorded with what the provider reported as it started.
      const settleStarted = Effect.fn("SessionProcessor.settleStarted")(function* (reason: string) {
        const started = ctx.started
        if (!started) return
        ctx.started = undefined
        const usage = Session.getUsage({ model: ctx.model, usage: started })
        if (attempt) {
          attempt = {
            usage: started,
            cost: attempt.cost + usage.cost,
            context: usage.tokens.input + usage.tokens.cache.read + usage.tokens.cache.write,
            cached: usage.tokens.cache.read,
            complete: false,
          }
          observe?.(attempt.cost)
        }
        ctx.assistantMessage.cost += usage.cost
        if (usage.unpriced) ctx.assistantMessage.unpriced = true
        ctx.assistantMessage.tokens = usage.tokens
        // Billed too, so it counts against the run, as a step that stopped where it was.
        yield* recordStep({
          costUsd: usage.cost,
          unpriced: usage.unpriced,
          tokens: usage.tokens,
          continues: false,
          patched: false,
        })
        yield* session.updatePart({
          id: PartID.ascending(),
          reason,
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.assistantMessage.sessionID,
          type: "step-finish",
          tokens: usage.tokens,
          cost: usage.cost,
          ...(usage.unpriced ? { unpriced: true } : {}),
        })
        yield* session.updateMessage(ctx.assistantMessage)
      })

      const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
        yield* settleStarted("other")
        // A step that never finished still records what its tools changed, before the loop moves on.
        if (ctx.snapshot || ctx.opening) {
          const start = ctx.snapshot
          const opening = ctx.opening
          ctx.snapshot = undefined
          ctx.opening = undefined
          const work = yield* enqueue(
            ctx.sessionID,
            Effect.gen(function* () {
              const from = start ?? (opening ? yield* result(opening) : undefined)
              if (from) yield* recordPatch(from)
            }),
          )
          yield* Fiber.await(work)
        }

        if (ctx.currentText) {
          const end = Date.now()
          ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
          yield* session.updatePart(ctx.currentText)
          ctx.currentText = undefined
        }

        for (const part of Object.values(ctx.reasoningMap)) {
          const end = Date.now()
          yield* session.updatePart({
            ...part,
            time: { start: part.time.start ?? end, end },
          })
        }
        ctx.reasoningMap = {}

        yield* Effect.forEach(
          Object.values(ctx.toolcalls),
          (call) => Deferred.await(call.done).pipe(Effect.timeout("250 millis"), Effect.ignore),
          { concurrency: "unbounded" },
        )

        for (const toolCallID of Object.keys(ctx.toolcalls)) {
          const match = yield* readToolCall(toolCallID)
          if (!match) continue
          const part = match.part
          const end = Date.now()
          const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
          yield* session.updatePart({
            ...part,
            state: {
              ...part.state,
              status: "error",
              error: "Tool execution aborted",
              metadata: { ...metadata, interrupted: true },
              time: { start: "time" in part.state ? part.state.time.start : end, end },
            },
          })
        }
        ctx.toolcalls = {}
        ctx.assistantMessage.time.completed = Date.now()
        yield* session.updateMessage(ctx.assistantMessage)
      })

      const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
        yield* Effect.logError("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
          error: errorMessage(e),
          stack: e instanceof Error ? e.stack : undefined,
        })
        const error = parse(e)
        if (SessionV1.ContextOverflowError.isInstance(error)) {
          if ((yield* config.get()).compaction?.auto === false && !ctx.assistantMessage.summary) {
            ctx.assistantMessage.error = error
            ctx.assistantMessage.finish = "error"
            yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
            yield* status.set(ctx.sessionID, { type: "idle" })
            return
          }
          ctx.needsCompaction = true
          yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
          return
        }
        ctx.assistantMessage.error = hosted ? explain(error, ctx.model.id, hosted) : error
        yield* events.publish(Session.Event.Error, {
          sessionID: ctx.assistantMessage.sessionID,
          error: ctx.assistantMessage.error,
        })
        yield* status.set(ctx.sessionID, { type: "idle" })
      })

      // Each tool call first waits for the session's queued snapshot work, so it never changes a file before the
      // snapshot that records the file's earlier state. The wrapped tool keeps its native-patch provenance.
      const gate = (tools: Record<string, Tool>, bridge: EffectBridge.Shape) =>
        Object.fromEntries(
          Object.entries(tools).map(([name, item]) => {
            const execute = item.execute
            if (!execute) return [name, item]
            const gated: Tool = {
              ...item,
              execute: (args, options) =>
                queues.has(ctx.sessionID)
                  ? bridge.promise(settle(ctx.sessionID)).then(() => execute(args, options))
                  : execute(args, options),
            }
            NativePatch.carry(item, gated)
            return [name, gated]
          }),
        )

      const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
        yield* Effect.logInfo("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
        })
        ctx.needsCompaction = false
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true
        const current = yield* SessionAdmission.Current
        const admission = current?.sessionID === input.sessionID ? current : undefined
        let denied = false
        const tools = gate(streamInput.tools, yield* EffectBridge.make())
        // An agent that works through tools must fit its fixed prompt on a server someone hosts. Hidden helpers, such
        // as compaction, run on any size.
        const refused =
          hosted && !streamInput.agent.hidden && Object.keys(streamInput.tools).length > 0
            ? refusal({
                model: streamInput.model,
                fixed: yield* fixedTokens(streamInput),
                agent: streamInput.agent.name,
              })
            : undefined
        if (refused) {
          ctx.assistantMessage.error = new SessionV1.APIError({
            message: refused,
            isRetryable: false,
            metadata: { code: "ContextTooSmall" },
          }).toObject()
          ctx.blocked = true
          yield* session.updateMessage(ctx.assistantMessage)
          yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error: ctx.assistantMessage.error })
          return "stop" as const
        }
        const model = line
          ? Provider.withPriority(streamInput.model, parentID ? "subagent" : "user")
          : streamInput.model

        return yield* Effect.gen(function* () {
          yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              ctx.currentText = undefined
              ctx.reasoningMap = {}
              ctx.stepTools = []
              // This body is also re-entered on every retry, and a run the spend guard stopped meanwhile, in this
              // session or anywhere in its lineage, starts no new attempt.
              const stop = yield* guard.stopped(ctx.sessionID)
              if (stop) {
                yield* stopTurn(stop)
                return
              }
              yield* restore(status.set(ctx.sessionID, { type: "busy" }))
              // This body is re-entered on every retry. Refusal is a normal stop, never a retryable provider error.
              const lease = admission?.admit({
                messageID: input.assistantMessage.id,
                model: input.model,
                tools: Object.keys(streamInput.tools),
              })
              if (admission && !lease) {
                denied = true
                return
              }
              if (lease) attempt = { cost: 0, context: 0, cached: 0, complete: false }
              observe = lease?.observe
              yield* restore(
                Effect.suspend(() =>
                  llm
                    .stream({
                      ...streamInput,
                      model,
                      // Hidden SDK retries would bypass the per-attempt admission boundary.
                      ...(admission ? { retries: 0 } : {}),
                      tools: lease?.tools
                        ? Object.fromEntries(Object.entries(tools).filter(([name]) => lease.tools?.includes(name)))
                        : tools,
                      started: (usage) => {
                        ctx.started = Usage.from(usage)
                        if (attempt)
                          observe?.(attempt.cost + Session.getUsage({ model: ctx.model, usage: ctx.started }).cost)
                      },
                    })
                    .pipe(
                      Stream.tap((event) => handleEvent(event)),
                      Stream.takeUntil(() => ctx.needsCompaction),
                      Stream.runDrain,
                    ),
                ),
              ).pipe(
                Effect.onExit((exit) =>
                  !lease
                    ? Effect.void
                    : settleStarted(
                        Exit.isFailure(exit) ? (Cause.hasInterruptsOnly(exit.cause) ? "abort" : "error") : "other",
                      ).pipe(
                        Effect.ensuring(
                          Effect.sync(() => {
                            if (!lease || !attempt) return
                            const result = attempt
                            attempt = undefined
                            observe = undefined
                            lease.settle(result)
                          }),
                        ),
                      ),
                ),
              )
            }),
          ).pipe(
            // Settled before a retry starts the step again, since the provider billed the failed attempt too.
            Effect.onError((cause) => settleStarted(Cause.hasInterruptsOnly(cause) ? "abort" : "error")),
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                aborted = true
                if (!ctx.assistantMessage.error) {
                  yield* halt(new DOMException("Aborted", "AbortError"))
                }
              }),
            ),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.fail(Cause.squash(cause)),
            ),
            Effect.retry(
              SessionRetry.policy({
                provider: input.model.providerID,
                parse,
                set: (info) => {
                  return status.set(ctx.sessionID, {
                    type: "retry",
                    attempt: info.attempt,
                    // A server someone hosts that is not running is retried too, with the fix in front meanwhile.
                    message: hosted ? fixed(info.message, ctx.model.id, hosted) : info.message,
                    action: info.action,
                    next: info.next,
                  })
                },
              }),
            ),
            Effect.catch(halt),
            Effect.ensuring(cleanup()),
          )

          if (denied) return "stop"
          if (ctx.needsCompaction) return "compact"
          if (ctx.blocked || ctx.assistantMessage.error) return "stop"
          return "continue"
        })
      })

      return {
        get message() {
          return ctx.assistantMessage
        },
        updateToolCall,
        completeToolCall,
        process,
      } satisfies Handle
    })

    return Service.of({ create, settle })
  }),
)

// A server someone hosts says what went wrong in its own terms; the common failures get their fix in front. When nothing
// answered at all, the words are the runtime's rather than the server's.
function fixed(message: string, model: string, origin: string, body = "") {
  const explained = LocalErrors.explain({ text: `${message} ${body}`, model, origin })
  if (!explained) return message
  const said = explained.kind === "connection-refused" ? "The error was" : "The server said"
  return `${explained.fix} ${said}: ${LocalErrors.plain(message)}`
}

// The error a step ends with. Besides the server's own refusals, an unknown error is how the runtime's fetch can report
// that nothing answered.
function explain(error: ReturnType<typeof MessageV2.fromError>, model: string, origin: string) {
  if (SessionV1.APIError.isInstance(error)) {
    const message = fixed(error.data.message, model, origin, error.data.responseBody)
    return message === error.data.message ? error : new SessionV1.APIError({ ...error.data, message }).toObject()
  }
  if (!NamedError.Unknown.isInstance(error)) return error
  const message = fixed(error.data.message, model, origin)
  return message === error.data.message ? error : new NamedError.Unknown({ message }).toObject()
}

// The part of every request an agent makes that does not change from step to step: the system prompt LLMRequestPrep
// builds (the agent's own prompt or the model's, then the stable and per-session parts) and the tool definitions.
const fixedTokens = (input: LLM.StreamInput) =>
  Effect.promise(async () => {
    const tools = await Promise.all(
      Object.entries(input.tools).map(async ([name, item]) =>
        JSON.stringify({
          name,
          description: item.description,
          parameters: item.inputSchema ? await asSchema(item.inputSchema).jsonSchema : {},
        }),
      ),
    )
    return Token.estimate(
      [
        ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
        ...(input.stableSystem ?? []),
        ...input.system,
        input.user.system ?? "",
        ...tools,
      ].join("\n"),
    )
  })

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Session.node,
    Config.node,
    Snapshot.node,
    Agent.node,
    LLM.node,
    Permission.node,
    Plugin.node,
    SessionSummary.node,
    SessionStatus.node,
    Image.node,
    EventV2Bridge.node,
    Database.node,
    Auth.node,
    SpendGuard.node,
    Provider.node,
    ModelSlots.node,
  ],
})

export * as SessionProcessor from "./processor"
