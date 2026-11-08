import { randomUUID } from "node:crypto"
import { Cause, Clock, Effect, Option, Schema, Semaphore } from "effect"
import { JsonSchemaCheck } from "@vectordevai/core/json-schema-check"
import type { RunBudget } from "@vectordevai/schema/run-budget"
import { SessionV1 } from "@vectordevai/core/v1/session"
import type { SubagentUsage } from "@/agent/subagent-kind"
import type { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import { TaskStructured } from "@/tool/task-structured"
import type { TaskPromptOps, TaskTool } from "@/tool/task"
import type { Tool } from "@/tool/tool"
import { WorkflowMarkers } from "./constants"

export type Request = {
  readonly marker: WorkflowMarkers.Agent
  readonly title: string
  readonly prompt: string
  readonly agent: string
  readonly model?: string
  readonly effort?: "default" | "low" | "medium" | "high"
  readonly isolation?: "none" | "worktree"
  readonly ownedPaths?: readonly string[]
  readonly successCriteria?: readonly string[]
  readonly outputSchema?: Record<string, unknown>
  readonly budget: RunBudget.Info
  readonly sessionID?: SessionID
  /** Only the runtime's scoped WorkflowLedger handle supplies this private guard binding. */
  readonly guardParent?: SessionID
}
export type Result = {
  readonly sessionID?: SessionID
  readonly messageID?: MessageID
  readonly retryable?: boolean
  readonly status: "completed" | "failed" | "cancelled"
  readonly output?: unknown
  readonly error?: string
  readonly usage?: SubagentUsage
}
export type Input = {
  readonly sessions: Session.Interface
  readonly task: Pick<Tool.InferDef<typeof TaskTool>, "execute">
  readonly ops: TaskPromptOps
  readonly runID: SessionID
  readonly message: Pick<SessionV1.Assistant, "parentID" | "modelID" | "providerID" | "path" | "variant">
  readonly ask: Tool.Context["ask"]
  readonly extra?: Readonly<Record<string, unknown>>
}

/** One runner's assistant messages and task parts. The task tool retains admission, budgets, repair and cancellation. */
export function make(input: Input) {
  const messageLock = Semaphore.makeUnsafe(1)
  const state: { message?: SessionV1.Assistant; parts: number } = { parts: 0 }
  const message = Effect.gen(function* () {
    if (!state.message || state.parts >= WorkflowMarkers.PARTS_PER_MESSAGE) {
      const now = yield* Clock.currentTimeMillis
      if (state.message)
        yield* input.sessions.updateMessage({
          ...state.message,
          time: { ...state.message.time, completed: now },
          finish: "tool-calls",
        })
      state.message = yield* input.sessions.updateMessage({
        ...input.message,
        id: MessageID.ascending(),
        sessionID: input.runID,
        role: "assistant",
        mode: WorkflowMarkers.WORKFLOW_AGENT,
        agent: WorkflowMarkers.WORKFLOW_AGENT,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: now },
      } satisfies SessionV1.Assistant)
      state.parts = 0
    }
    state.parts += 1
    return state.message
  }).pipe(SubagentLifecycle.locked(messageLock))

  const node = Effect.fn("WorkflowLaunch.node")(function* (
    request: Request,
    onSession: (sessionID: SessionID) => Effect.Effect<void>,
  ) {
    const owner = yield* message
    const started = yield* Clock.currentTimeMillis
    const args = {
      description: request.title,
      prompt: request.prompt,
      subagent_type: request.agent,
      background: false,
      model: request.model,
      effort: request.effort,
      isolation: request.isolation === "worktree" ? ("worktree" as const) : undefined,
      owned_paths: request.ownedPaths ? [...request.ownedPaths] : undefined,
      success_criteria: request.successCriteria ? [...request.successCriteria] : undefined,
      output_schema: request.outputSchema,
      budget: request.budget,
      task_id: request.sessionID,
    }
    const live: { part: SessionV1.ToolPart; child?: SessionID; notified: boolean } = {
      part: yield* input.sessions.updatePart({
        id: PartID.ascending(),
        messageID: owner.id,
        sessionID: input.runID,
        type: "tool",
        tool: "task",
        callID: randomUUID(),
        metadata: { workflow: request.marker },
        state: { status: "running", input: args, time: { start: started } },
      } satisfies SessionV1.ToolPart),
      child: request.sessionID,
      notified: false,
    }
    const abort = new AbortController()
    let failure: string | undefined
    const result = yield* input.task
      .execute(args, {
        sessionID: input.runID,
        messageID: owner.id,
        agent: WorkflowMarkers.WORKFLOW_AGENT,
        callID: live.part.callID,
        abort: abort.signal,
        // TaskTool reads no caller history. Loading the run's whole transcript (every task part with its brief) for each
        // launch would grow quadratically over a large fan-out.
        messages: [],
        extra: {
          ...input.extra,
          promptOps: input.ops,
          [WorkflowMarkers.AGENT]: request.marker,
          [WorkflowMarkers.GUARD_PARENT]: request.guardParent,
        },
        ask: input.ask,
        metadata: (value) =>
          Effect.gen(function* () {
            if (typeof value.metadata?.sessionId === "string") {
              const child = SessionID.make(value.metadata.sessionId)
              if (!live.notified || live.child !== child) yield* onSession(child)
              live.child = child
              live.notified = true
            }
            if (live.part.state.status !== "running") return
            live.part = yield* input.sessions.updatePart({
              ...live.part,
              state: { ...live.part.state, ...value },
            } satisfies SessionV1.ToolPart)
          }),
      })
      .pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
          return Effect.sync(() => {
            failure = String(Cause.squash(cause))
            return undefined
          })
        }),
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            abort.abort()
            if (live.child) yield* input.ops.cancel(live.child)
            yield* input.sessions.updatePart({
              ...live.part,
              state: {
                status: "error",
                input: args,
                error: "Interrupted",
                metadata: { interrupted: true },
                time: { start: started, end: yield* Clock.currentTimeMillis },
              },
            } satisfies SessionV1.ToolPart)
          }),
        ),
      )
    const child =
      live.child ??
      (result && "sessionId" in result.metadata && typeof result.metadata.sessionId === "string"
        ? SessionID.make(result.metadata.sessionId)
        : undefined)
    if (!child) {
      yield* input.sessions.updatePart({
        ...live.part,
        state: {
          status: "error",
          input: args,
          error: failure ?? "Workflow task returned without a child session.",
          time: { start: started, end: yield* Clock.currentTimeMillis },
        },
      } satisfies SessionV1.ToolPart)
      return { status: "failed" as const, error: failure ?? "Workflow task returned without a child session." }
    }
    if (!live.notified) yield* onSession(child)
    const info = yield* input.sessions.get(child).pipe(Effect.orDie)
    const record = SubagentLifecycle.read(info)
    if (!record || SubagentLifecycle.open(record)) {
      // A workflow launch must never be promoted. Fail closed while WP31's marker guard is authoritative.
      yield* input.ops.cancel(child)
      yield* input.sessions.updatePart({
        ...live.part,
        state: {
          status: "error",
          input: args,
          error: "Workflow task did not settle its child.",
          time: { start: started, end: yield* Clock.currentTimeMillis },
        },
      } satisfies SessionV1.ToolPart)
      return {
        sessionID: child,
        status: "cancelled" as const,
        retryable: false,
        error: "Workflow task did not settle its child.",
      }
    }
    let status: Result["status"] =
      record.status === "cancelled" ? "cancelled" : !failure && record.status === "completed" ? "completed" : "failed"
    let output: unknown
    let messageID: MessageID | undefined
    // TaskTool already calls TaskStructured.settle. A user-stopped child never reaches a repair here.
    if (status === "completed") {
      const messages = yield* input.sessions.messages({ sessionID: child })
      const last = messages.findLast((entry) => entry.info.role === "assistant")
      messageID = last?.info.id
      if (request.outputSchema) {
        const json = TaskStructured.latest(messages)
        const parsed =
          json === undefined ? Option.none() : Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(json)
        if (Option.isNone(parsed) || JsonSchemaCheck.validate(request.outputSchema, parsed.value).length) {
          status = "failed"
          failure = "The task ended without valid structured output."
        } else output = parsed.value
      } else
        output =
          last?.parts
            .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
            .join("\n\n") ?? ""
    }
    yield* input.sessions.updatePart({
      ...live.part,
      state:
        status === "completed"
          ? {
              status: "completed",
              input: args,
              title: result?.title ?? request.title,
              metadata: result?.metadata ?? {},
              output: result?.output ?? "",
              time: { start: started, end: yield* Clock.currentTimeMillis },
            }
          : {
              status: "error",
              input: args,
              metadata: result?.metadata ?? {},
              error: failure ?? record.error ?? (status === "cancelled" ? "Cancelled" : "Task failed"),
              time: { start: started, end: yield* Clock.currentTimeMillis },
            },
    } satisfies SessionV1.ToolPart)
    const canonical = info.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    return {
      sessionID: child,
      messageID,
      status,
      output,
      error: failure ?? record.error,
      usage: record.usage
        ? {
            ...record.usage,
            // Lifecycle metadata cannot grant provenance. Certify only quantities
            // that exactly match this authoritative Session observation.
            tokensOwnOnly:
              info.tokensOwnOnly === true &&
              record.usage.total ===
                canonical.input +
                  canonical.output +
                  canonical.reasoning +
                  canonical.cache.read +
                  canonical.cache.write &&
              record.usage.tokens.input === canonical.input &&
              record.usage.tokens.output === canonical.output &&
              record.usage.tokens.reasoning === canonical.reasoning &&
              record.usage.tokens.cache.read === canonical.cache.read &&
              record.usage.tokens.cache.write === canonical.cache.write,
          }
        : undefined,
    } satisfies Result
  })
  const finish = Effect.fn("WorkflowLaunch.finish")(function* (text: string) {
    const owner = yield* message
    yield* input.sessions.updatePart({
      id: PartID.ascending(),
      messageID: owner.id,
      sessionID: input.runID,
      type: "text",
      text,
    } satisfies SessionV1.TextPart)
    yield* input.sessions.updateMessage({
      ...owner,
      time: { ...owner.time, completed: yield* Clock.currentTimeMillis },
      finish: "stop",
    })
  })
  return { node, finish }
}

export * as WorkflowLaunch from "./launch"
