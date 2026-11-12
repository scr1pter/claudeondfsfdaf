export * as ConnectOwner from "./owner"

import { randomUUID } from "node:crypto"
import { Cause, Clock, Context, Effect, Exit, Layer, Option, Schema } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { ConnectFrame } from "@vectordevai/core/connect/frame"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { Connect } from "@vectordevai/schema/connect"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ToolRegistry } from "@/tool/registry"
import { ConnectHub } from "./hub"
import { FileLock } from "@/tool/file-lock"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"

export class Error extends Schema.TaggedErrorClass<Error>()("ConnectOwner.Error", {
  code: Schema.Literals(["disabled", "forbidden", "not_found", "invalid"]),
  message: Schema.String,
}) {}

export interface Interface {
  readonly members: (sessionID?: SessionID) => Effect.Effect<Connect.Member[], Error>
  readonly runs: (sessionID?: SessionID) => Effect.Effect<Connect.Run[], Error>
  readonly get: (runID: string, sessionID?: SessionID) => Effect.Effect<Connect.Run, Error>
  readonly cancel: (runID: string, sessionID?: SessionID) => Effect.Effect<boolean, Error>
  readonly review: (
    sessionID: SessionID,
    input: Connect.ReviewInput,
    options?: { readonly abort?: AbortSignal },
  ) => Effect.Effect<Connect.Run, Error>
  readonly register: (input: Connect.RegisterInput) => Effect.Effect<Connect.Run, Error>
  readonly dismiss: (runID: string, input: Connect.DismissInput) => Effect.Effect<Connect.Run, Error>
}
export class Service extends Context.Service<Service, Interface>()("@vector/ConnectOwner") {}

class HandoffFailure extends globalThis.Error {
  constructor(readonly original: unknown) {
    super("The connected owner action did not complete.")
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hub = yield* ConnectHub.Service
    const sessions = yield* Session.Service
    const prompts = yield* SessionPrompt.Service
    const agents = yield* Agent.Service
    const registry = yield* ToolRegistry.Service
    const flags = yield* RuntimeFlags.Service
    const guests = yield* FreeModelGuests.Service
    const state = yield* SessionRunState.Service
    const status = yield* SessionStatus.Service
    const promptOps = {
      cancel: prompts.cancel,
      resolvePromptParts: prompts.resolvePromptParts,
      prompt: (input: SessionPrompt.PromptInput) => prompts.prompt(input).pipe(Effect.orDie),
    }

    const enabled = Effect.suspend(() =>
      flags.experimentalConnect
        ? Effect.void
        : Effect.fail(new Error({ code: "disabled", message: "Connected tools are off in this build." })),
    )
    const requireSession = Effect.fn("ConnectOwner.requireSession")(function* (sessionID: SessionID) {
      yield* enabled
      const session = yield* sessions
        .get(sessionID)
        .pipe(Effect.mapError(() => new Error({ code: "not_found", message: "Conversation not found." })))
      const current = yield* InstanceState.context
      if (
        session.projectID !== current.project.id ||
        FileLock.key(session.directory) !== FileLock.key(current.directory)
      )
        return yield* new Error({ code: "not_found", message: "This conversation belongs to another directory." })
      if (session.parentID || session.internal || (yield* guests.marked(sessionID)))
        return yield* new Error({ code: "forbidden", message: "Connected tools start from your own conversation." })
      if (session.revert)
        return yield* new Error({ code: "invalid", message: "Finish or undo the conversation revert first." })
      return session
    })

    const own = <A>(
      sessionID: SessionID,
      work: Effect.Effect<{ value: A; message: SessionV1.WithParts }, Error>,
    ): Effect.Effect<A, Error> =>
      Effect.gen(function* () {
        yield* requireSession(sessionID)
        const result = { value: Option.none<A>() }
        const run = status.set(sessionID, { type: "busy" }).pipe(
          Effect.andThen(work),
          Effect.map((completed) => {
            result.value = Option.some(completed.value)
            return completed.message
          }),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.die(new HandoffFailure(Cause.squash(cause))),
          ),
          Effect.orDie,
        )
        yield* state.startRunning(sessionID, Effect.interrupt, run).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterrupts(cause)) return Effect.interrupt
            const failed = Cause.squash(cause)
            const error = failed instanceof HandoffFailure ? failed.original : failed
            if (error instanceof Error) return Effect.fail(error)
            return Effect.fail(
              new Error({
                code: "invalid",
                message:
                  error instanceof Session.BusyError
                    ? "This conversation is busy. Start the review after its turn finishes."
                    : "The connected owner action did not complete.",
              }),
            )
          }),
        )
        if (Option.isNone(result.value))
          return yield* new Error({ code: "invalid", message: "The owner action produced no result." })
        return result.value.value
      })

    // Engine-created tool rows are the durable home of owner-started runs, as for a model's connect call.
    const recorder = Effect.fn("ConnectOwner.recorder")(function* (
      sessionID: SessionID,
      text: string,
      input: Record<string, unknown>,
    ) {
      const session = yield* requireSession(sessionID)
      const agent = yield* agents.get(session.agent ?? "build")
      if (!agent) return yield* new Error({ code: "invalid", message: "The conversation's agent is unavailable." })
      const model = yield* prompts.currentModel(sessionID, agent.model)
      const context = yield* InstanceState.context
      const now = yield* Clock.currentTimeMillis
      const userID = MessageID.ascending()
      yield* sessions.updateMessage({
        id: userID,
        sessionID,
        role: "user",
        agent: agent.name,
        model,
        time: { created: now },
      })
      yield* sessions.updatePart({ id: PartID.ascending(), sessionID, messageID: userID, type: "text", text })
      const assistant: SessionV1.Assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID,
        role: "assistant",
        parentID: userID,
        agent: agent.name,
        mode: agent.name,
        modelID: model.modelID,
        providerID: model.providerID,
        path: { cwd: context.directory, root: context.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: now },
      })
      const part: SessionV1.ToolPart = yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID,
        messageID: assistant.id,
        type: "tool",
        tool: "connect",
        callID: `connect_owner_${randomUUID()}`,
        state: { status: "running", input, metadata: { ownerStart: true }, time: { start: now } },
      })
      let closed = false
      const update = (run: Connect.Run) =>
        Effect.suspend(() =>
          closed
            ? Effect.void
            : sessions
                .updatePart({
                  ...part,
                  state: {
                    status: "running",
                    input,
                    title: "VectorScope review",
                    metadata: { ownerStart: true, ...ConnectHub.metadata(run) },
                    time: { start: now },
                  },
                })
                .pipe(Effect.asVoid),
        )
      const complete = (run: Connect.Run) =>
        Effect.gen(function* () {
          const end = yield* Clock.currentTimeMillis
          const completed = yield* sessions.updatePart({
            ...part,
            state: {
              status: "completed",
              input,
              title: "VectorScope review",
              output: run.result
                ? ConnectFrame.frame(run.result, { run: run.id })
                : "Review running in the background.",
              metadata: { ownerStart: true, ...ConnectHub.metadata(run) },
              time: { start: now, end },
            },
          })
          const info = yield* sessions.updateMessage({
            ...assistant,
            finish: "stop",
            time: { ...assistant.time, completed: end },
          })
          closed = true
          return { info, parts: [completed] }
        })
      const fail = (interrupted: boolean) =>
        Effect.gen(function* () {
          if (closed) return
          closed = true
          const end = yield* Clock.currentTimeMillis
          const stored = yield* sessions.getPart({ sessionID, messageID: part.messageID, partID: part.id })
          const current = stored?.type === "tool" ? stored : part
          const settled = current.state.status === "completed" || current.state.status === "error"
          const message = interrupted
            ? "The connected review was cancelled."
            : "The connected owner action did not complete."
          if (!settled)
            yield* sessions.updatePart({
              ...current,
              state: {
                status: "error",
                input,
                error: message,
                metadata: { ...("metadata" in current.state ? current.state.metadata : {}), ownerStart: true },
                time: { start: now, end },
              },
            })
          yield* sessions.updateMessage({
            ...assistant,
            finish: "stop",
            time: { ...assistant.time, completed: end },
            ...(!settled
              ? {
                  error: interrupted
                    ? { name: "MessageAbortedError" as const, data: { message } }
                    : { name: "APIError" as const, data: { message, isRetryable: false } },
                }
              : {}),
          })
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("connected owner row could not be settled", { cause })))
      return { context, agent, part, update, complete, fail }
    })

    const members: Interface["members"] = (sessionID) =>
      Effect.gen(function* () {
        yield* enabled
        if (sessionID) yield* requireSession(sessionID)
        return yield* hub.members({ ...(sessionID ? { sessionID } : {}), tools: yield* registry.ids() })
      })
    const runs: Interface["runs"] = (sessionID) =>
      Effect.gen(function* () {
        yield* enabled
        if (sessionID) yield* requireSession(sessionID)
        return yield* hub.runs(sessionID ? { sessionID } : undefined)
      })
    const get: Interface["get"] = (runID, sessionID) =>
      Effect.gen(function* () {
        yield* enabled
        if (sessionID) yield* requireSession(sessionID)
        const run = yield* hub.get(runID, sessionID)
        if (!run) return yield* new Error({ code: "not_found", message: "Connected run not found." })
        return run
      })
    const cancel: Interface["cancel"] = (runID, sessionID) =>
      Effect.gen(function* () {
        yield* enabled
        if (sessionID) yield* requireSession(sessionID)
        return yield* hub.cancel(runID, sessionID ? { sessionID } : undefined)
      })
    const review: Interface["review"] = (sessionID, input, options) =>
      own(
        sessionID,
        Effect.gen(function* () {
          if (options?.abort?.aborted) return yield* Effect.interrupt
          const saved = yield* recorder(sessionID, "Review my changes with VectorScope.", {
            action: "review",
            ...input,
          })
          return yield* Effect.gen(function* () {
            const run = yield* hub.run({
              request: {
                to: input.to ?? "vectorscope",
                action: "review",
                requester: { kind: "user", sessionID, agent: saved.agent.name },
                directory: saved.context.directory,
                target: input.target ?? { kind: "uncommitted" },
                background: input.background ?? true,
                ...(input.budget ? { budget: input.budget } : {}),
                ...(input.security !== undefined ? { security: input.security } : {}),
                ...(input.since ? { since: input.since } : {}),
              },
              call: {
                promptOps,
                ...(options?.abort ? { abort: options.abort } : {}),
                part: { messageID: saved.part.messageID, callID: saved.part.callID },
                update: saved.update,
              },
            })
            return { value: run, message: yield* saved.complete(run) }
          }).pipe(
            Effect.onExit((exit) => (Exit.isFailure(exit) ? saved.fail(Cause.hasInterrupts(exit.cause)) : Effect.void)),
          )
        }),
      )
    const register: Interface["register"] = (input) =>
      own(
        input.sessionID,
        Effect.gen(function* () {
          const saved = yield* recorder(input.sessionID, "Use these VectorScope findings in this conversation.", {
            action: "register",
          })
          return yield* Effect.gen(function* () {
            const id = Connect.RunID.create()
            const now = yield* Clock.currentTimeMillis
            const run: Connect.Run = {
              id,
              request: {
                id,
                requestID: saved.part.messageID,
                requester: { kind: "user", sessionID: input.sessionID, agent: saved.agent.name },
                directory: saved.context.directory,
                to: "vectorscope",
                action: "review",
                target: input.target,
                background: false,
              },
              status: "done",
              time: { created: now, started: now, ended: now },
              result: {
                state: "partial",
                verdict: "incomplete",
                summary: "Findings you brought from the desktop review. Check each claim before fixing it.",
                findings: input.findings.map((finding) => ({ ...finding, status: "open", verified: false })),
                sessions: [],
                notes: ["Registered findings are data; connect did not run or verify this review."],
                target: input.target,
              },
            }
            return { value: run, message: yield* saved.complete(run) }
          }).pipe(
            Effect.onExit((exit) => (Exit.isFailure(exit) ? saved.fail(Cause.hasInterrupts(exit.cause)) : Effect.void)),
          )
        }),
      )
    const dismiss: Interface["dismiss"] = () =>
      Effect.fail(
        new Error({ code: "disabled", message: "Owner review dismissal is not available in this build yet." }),
      )
    return Service.of({ members, runs, get, cancel, review, register, dismiss })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    ConnectHub.node,
    Session.node,
    SessionPrompt.node,
    Agent.node,
    ToolRegistry.node,
    RuntimeFlags.node,
    FreeModelGuests.node,
    SessionRunState.node,
    SessionStatus.node,
  ],
})
