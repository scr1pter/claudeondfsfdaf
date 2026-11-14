export * as ConnectOwner from "./owner"

import { randomUUID } from "node:crypto"
import { Cause, Clock, Context, Effect, Exit, Layer, Option, Schema } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainDatabase } from "@vectordevai/core/brain/database"
import { ConnectPolicy } from "@vectordevai/core/connect/policy"
import { Instruction } from "@/session/instruction"
import { ConnectContext } from "./context"
import { ConnectDirectory } from "./directory"
import { ConnectDirectoryRequest } from "./directory-request"
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
import { WorkflowMarkers } from "@/orchestration/constants"
import { WorkflowOwnerHandoffFailure } from "@/orchestration/owner-failure"
import { Config } from "@/config/config"
import { ConfigConnectV1 } from "@vectordevai/core/v1/config/connect"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { SessionStatusEvent } from "@vectordevai/schema/session-status-event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceHooks } from "@/project/instance-hooks"
import { ConnectAfterRun } from "./after-run"
import { ConnectNote } from "./note"
import { TaskNotify } from "@/task/notify"
import { TaskPlace } from "@/task/place"

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
  readonly directoryReview: (
    input: Connect.DirectoryReviewInput,
    options?: { readonly abort?: AbortSignal },
  ) => Effect.Effect<Connect.Run, Error>
  readonly register: (input: Connect.RegisterInput) => Effect.Effect<Connect.Run, Error>
  readonly dismiss: (runID: string, input: Connect.DismissInput) => Effect.Effect<Connect.Run, Error>
  readonly init: () => Effect.Effect<void>
}
export class Service extends Context.Service<Service, Interface>()("@vector/ConnectOwner") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hub = yield* ConnectHub.Service
    const directoryRequests = yield* ConnectDirectoryRequest.Service
    const brain = yield* Brain.Service
    const brainDatabase = yield* BrainDatabase.Service
    const instruction = yield* Instruction.Service
    const sessions = yield* Session.Service
    const prompts = yield* SessionPrompt.Service
    const agents = yield* Agent.Service
    const registry = yield* ToolRegistry.Service
    const flags = yield* RuntimeFlags.Service
    const guests = yield* FreeModelGuests.Service
    const state = yield* SessionRunState.Service
    const status = yield* SessionStatus.Service
    const config = yield* Config.Service
    const audience = yield* SessionAudience.Service
    const guard = yield* SpendGuard.Service
    const events = yield* EventV2Bridge.Service
    const hooks = yield* InstanceHooks.Service
    const notify = yield* TaskNotify.Service
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
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Effect.die(new WorkflowOwnerHandoffFailure(Cause.squash(cause))),
          ),
          Effect.orDie,
        )
        yield* state.startRunning(sessionID, Effect.interrupt, run).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterrupts(cause)) return Effect.interrupt
            const failed = Cause.squash(cause)
            const error = failed instanceof WorkflowOwnerHandoffFailure ? failed.original : failed
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
      afterRun?: ConnectAfterRun.Marker,
    ) {
      // Reserve the explicit owner action before model/config resolution can let a newer human message arrive.
      const userID = afterRun?.requestID ?? MessageID.ascending()
      const assistantID = MessageID.ascending()
      const session = yield* requireSession(sessionID)
      const agent = yield* agents.get(session.agent ?? "build")
      if (!agent) return yield* new Error({ code: "invalid", message: "The conversation's agent is unavailable." })
      const model = yield* prompts.currentModel(sessionID, agent.model)
      if (afterRun && (yield* hub.request(sessionID)).requestID !== afterRun.requestID)
        return yield* new Error({ code: "invalid", message: "The automatic review was superseded by a new request." })
      const context = yield* InstanceState.context
      const now = yield* Clock.currentTimeMillis
      if (!afterRun) {
        yield* sessions.updateMessage({
          id: userID,
          sessionID,
          role: "user",
          agent: agent.name,
          model,
          time: { created: now },
        })
        yield* sessions.updatePart({ id: PartID.ascending(), sessionID, messageID: userID, type: "text", text })
      }
      const provenance = { ownerStart: true, [WorkflowMarkers.OWNER_START]: true, ...(afterRun ? { afterRun } : {}) }
      const assistant: SessionV1.Assistant = yield* sessions.updateMessage({
        id: assistantID,
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
        state: {
          status: "running",
          input,
          metadata: provenance,
          time: { start: now },
        },
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
                    metadata: { ...provenance, ...ConnectHub.metadata(run) },
                    time: { start: now },
                  },
                })
                .pipe(Effect.asVoid),
        )
      const complete = (run: Connect.Run, acknowledgement?: string) =>
        Effect.gen(function* () {
          const end = yield* Clock.currentTimeMillis
          const completed = yield* sessions.updatePart({
            ...part,
            state: {
              status: "completed",
              input,
              title: acknowledgement ? "VectorScope findings dismissed" : "VectorScope review",
              output:
                acknowledgement ??
                (run.result ? ConnectFrame.frame(run.result, { run: run.id }) : "Review running in the background."),
              metadata: {
                ...provenance,
                ...(acknowledgement
                  ? { action: "dismiss", run: run.id, findings: input.findings }
                  : ConnectHub.metadata(run)),
              },
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
                metadata: {
                  ...("metadata" in current.state ? current.state.metadata : {}),
                  ...provenance,
                },
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
    const directoryReview: Interface["directoryReview"] = (input, options) =>
      Effect.gen(function* () {
        yield* enabled
        const checked = yield* Schema.decodeUnknownEffect(Connect.DirectoryReviewInput)(input).pipe(
          Effect.mapError(
            () => new Error({ code: "invalid", message: "A directory review requires a stable UUID request key." }),
          ),
        )
        if (options?.abort?.aborted) return yield* Effect.interrupt
        if (
          (checked.to !== undefined && checked.to !== "vectorscope") ||
          checked.target?.kind === "task" ||
          checked.background === false
        )
          return yield* new Error({
            code: "invalid",
            message:
              "Directory reviews run VectorScope as an owner-controlled job; task reviews use their launching conversation.",
          })
        const current = yield* InstanceState.context
        if (TaskPlace.isTaskDirectory(current.directory))
          return yield* new Error({
            code: "forbidden",
            message: "Review this task from its launching conversation so its worktree ownership stays protected.",
          })
        const attempt = yield* directoryRequests
          .reserve({ projectID: current.project.id, directory: current.directory }, checked)
          .pipe(Effect.mapError((error) => new Error({ code: "invalid", message: error.message })))
        if (attempt.kind === "bound") {
          const original = yield* hub.replayDirectory({
            ...attempt.proof,
            runID: attempt.binding.runID,
            anchorID: attempt.binding.anchorID,
          })
          if (!original)
            return yield* new Error({
              code: "invalid",
              message:
                "This request key is consumed, but its original owned run is unavailable. No new review was started.",
            })
          return original
        }
        const requested = attempt.claim.input
        const name = yield* agents.defaultAgent()
        const agent = yield* agents.get(name)
        if (!agent) return yield* new Error({ code: "invalid", message: "The owner's agent is unavailable." })
        const anchor = yield* sessions.create({
          title: "VectorScope directory review",
          internal: ConnectDirectory.INTERNAL,
        })
        yield* audience
          .fenceIsolation({ sessionID: anchor.id, actor: "owner" })
          .pipe(
            Effect.mapError(
              () => new Error({ code: "forbidden", message: "The directory owner could not be verified." }),
            ),
          )
        const token = yield* ConnectDirectory.issue(
          {
            sessionID: anchor.id,
            projectID: current.project.id,
            directory: current.directory,
          },
          attempt.claim.scope,
        ).pipe(Effect.mapError((error) => new Error({ code: "invalid", message: error.message })))
        const run = yield* hub.run({
          request: {
            to: "vectorscope",
            action: "review",
            requester: { kind: "user", agent: agent.name },
            directory: current.directory,
            target: requested.target ?? { kind: "uncommitted" },
            background: true,
            ...(requested.budget ? { budget: requested.budget } : {}),
            ...(requested.security !== undefined ? { security: requested.security } : {}),
            ...(requested.since ? { since: requested.since } : {}),
          },
          call: {
            directory: {
              token,
              request: attempt.claim.proof,
              bind: (run) => directoryRequests.bind(attempt.token, { anchorID: anchor.id, runID: run.id }),
              complete: (run) => ConnectDirectory.write(token, run),
            },
            promptOps,
            ...(options?.abort ? { abort: options.abort } : {}),
            update: (run) => ConnectDirectory.write(token, run).pipe(Effect.asVoid, Effect.orDie),
          },
        })
        if (run.status === "done" && run.result?.state === "refused")
          return yield* new Error({ code: "invalid", message: run.result.summary })
        return run
      })
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
    const dismiss: Interface["dismiss"] = (runID, input) =>
      own(
        input.sessionID,
        Effect.gen(function* () {
          // Recorder reserves the click's message id before any async lookup can admit a newer human message.
          const saved = yield* recorder(
            input.sessionID,
            `Dismiss ${new Set(input.findings).size} selected findings from review ${runID}.`,
            { action: "dismiss", run: runID, findings: [...input.findings] },
          )
          return yield* Effect.gen(function* () {
            const current = yield* get(runID, input.sessionID)
            if (!ConnectContext.dismissed(current, input.findings))
              return yield* new Error({
                code: "invalid",
                message: "Choose findings from a completed review in this conversation.",
              })
            const place = yield* instruction.place()
            const applied = yield* hub.dismiss(runID, input.sessionID, input.findings, (findings) =>
              brainDatabase.db
                .transaction(() =>
                  Effect.gen(function* () {
                    // One refusal rolls back the whole clicked batch, including earlier dedup/evidence updates.
                    for (const finding of findings) {
                      const relative = ConnectPolicy.normalizePath(finding.path)
                      if (!relative)
                        return yield* new Error({
                          code: "invalid",
                          message: "That finding has no repository path to remember.",
                        })
                      const result = yield* brain.dismissReview(place, {
                        text: ConnectContext.dismissalText(finding, input.reason),
                        paths: [relative],
                        sessionID: input.sessionID,
                      })
                      if (result.type === "refused")
                        return yield* new Error({ code: "invalid", message: result.message })
                    }
                  }),
                )
                .pipe(
                  Effect.catchTag("SqlError", () =>
                    Effect.fail(
                      new Error({ code: "invalid", message: "Review dismissal context could not be saved." }),
                    ),
                  ),
                ),
            )
            if (!applied)
              return yield* new Error({
                code: "invalid",
                message:
                  "The review row is no longer available. Any review notes already saved remain in repository memory.",
              })
            return {
              value: applied,
              message: yield* saved.complete(
                applied,
                `Dismissed ${new Set(input.findings).size} findings and saved repository review context.`,
              ),
            }
          }).pipe(
            Effect.onExit((exit) => (Exit.isFailure(exit) ? saved.fail(Cause.hasInterrupts(exit.cause)) : Effect.void)),
          )
        }),
      )
    const loops = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        const context = yield* InstanceState.context
        const pending = new Set<SessionID>()
        const busy = new Set<SessionID>()
        const after = Effect.fn("ConnectOwner.afterRun")(function* (sessionID: SessionID) {
          if (!flags.experimentalConnect || pending.has(sessionID)) return
          const settings = (yield* config.get()).connect
          const selected = ConfigConnectV1.review(settings)
          if (selected.after_run === "off") return
          const session = yield* sessions.get(sessionID).pipe(Effect.option)
          if (Option.isNone(session)) return
          if (session.value.parentID || session.value.internal || (session.value.agent ?? "build") !== "build") return
          const current = yield* hub.request(sessionID)
          if (!current.requestID) return
          const messages = yield* sessions.messages({ sessionID })
          const previous = ConnectAfterRun.history(messages, yield* hub.runs({ sessionID }), current.requestID)
          const snapshot = yield* guard.snapshot(sessionID)
          const next = ConnectAfterRun.eligible({
            session: session.value,
            messages,
            config: settings,
            ...(previous ? { previous } : {}),
            stopped: !!((yield* guard.stopped(sessionID)) ?? snapshot?.stopped),
            guest: (yield* audience.hasGuestInput(sessionID)) || (yield* guests.marked(sessionID)),
            requestID: current.requestID,
          })
          if (!next) return
          const remaining =
            snapshot?.budget.usd === undefined ? 0.5 : Math.max(0, snapshot.budget.usd - snapshot.spentUsd)
          if (remaining <= 0) return
          const repairBudget = {
            ...snapshot?.budget,
            usd: remaining,
            ...(snapshot?.budget.steps !== undefined
              ? { steps: Math.max(0, snapshot.budget.steps - snapshot.steps) }
              : {}),
            ...(snapshot?.budget.unpricedSteps !== undefined
              ? { unpricedSteps: Math.max(0, snapshot.budget.unpricedSteps - snapshot.unpricedSteps) }
              : {}),
          }
          const marker = Schema.decodeUnknownSync(ConnectAfterRun.Marker)({ ...next, version: 1 })
          const afterRunCurrent = Effect.gen(function* () {
            if ((yield* hub.request(sessionID)).requestID !== next.requestID) return false
            if ((yield* audience.hasGuestInput(sessionID)) || (yield* guests.marked(sessionID))) return false
            return ConfigConnectV1.review((yield* config.get()).connect).after_run !== "off"
          })
          const repairCurrent = afterRunCurrent.pipe(
            Effect.flatMap((allowed) =>
              allowed
                ? config.get().pipe(Effect.map((value) => ConfigConnectV1.review(value.connect).after_run === "repair"))
                : Effect.succeed(false),
            ),
          )
          pending.add(sessionID)
          yield* own(
            sessionID,
            Effect.gen(function* () {
              const saved = yield* recorder(sessionID, "", { action: "review", automatic: true }, marker)
              return yield* Effect.gen(function* () {
                const run = yield* hub.run({
                  request: {
                    to: "vectorscope",
                    action: "review",
                    requester: { kind: "agent", sessionID, agent: saved.agent.name },
                    directory: saved.context.directory,
                    target: { kind: "uncommitted" },
                    background: true,
                    budget: { maxCostUsd: Math.min(selected.max_cost_usd, remaining) },
                  },
                  call: {
                    promptOps,
                    unattended: true,
                    repair: next.mode === "repair",
                    repairBudget,
                    expectedRequestID: next.requestID,
                    afterRunCurrent,
                    repairCurrent,
                    part: { messageID: saved.part.messageID, callID: saved.part.callID },
                    update: saved.update,
                  },
                })
                const message = yield* saved.complete(run)
                // A run that finished before detach returned has no background note; the automatic caller reports it.
                if (run.status === "done") {
                  const budget = ConnectNote.repairBudget(run, repairBudget)
                  const repair = next.mode === "repair" && budget !== undefined && (yield* repairCurrent)
                  yield* notify.enqueue({
                    parentID: sessionID,
                    note: {
                      ...ConnectNote.note(run, saved.part.messageID, { automatic: true, repair }),
                      ...(repair && budget
                        ? {
                            connectRepair: {
                              requestID: next.requestID,
                              budget,
                              current: repairCurrent,
                            },
                          }
                        : {}),
                    },
                    ops: promptOps,
                    agent: saved.agent.name,
                  })
                }
                return { value: run, message }
              }).pipe(
                Effect.onExit((exit) =>
                  Exit.isFailure(exit) ? saved.fail(Cause.hasInterrupts(exit.cause)) : Effect.void,
                ),
              )
            }),
          ).pipe(Effect.ensuring(Effect.sync(() => pending.delete(sessionID))))
        })
        const unsubscribe = yield* events.listen((event) => {
          if (event.type !== SessionStatusEvent.Status.type || event.location?.directory !== context.directory)
            return Effect.void
          const decoded = Schema.decodeUnknownOption(SessionStatusEvent.Status.data)(event.data)
          if (Option.isNone(decoded)) return Effect.void
          if (decoded.value.status.type === "busy") {
            busy.add(decoded.value.sessionID)
            return Effect.void
          }
          // A recovery or cold idle notification must never start implicit work from an earlier process.
          if (decoded.value.status.type !== "idle" || !busy.delete(decoded.value.sessionID)) return Effect.void
          // Admission is awaited before later /event listeners can observe this idle. The real cr_ BackgroundJob
          // and its durable tool row exist before the headless client decides whether it has work left to await.
          return after(decoded.value.sessionID).pipe(
            Effect.catchCause((cause) => Effect.logWarning("after-run review did not start", { cause })),
          )
        })
        yield* Effect.addFinalizer(() => unsubscribe)
      }),
    )
    const init = () => (flags.experimentalConnect ? InstanceState.get(loops).pipe(Effect.asVoid) : Effect.void)
    yield* hooks.register("connected-tools", init())
    return Service.of({ members, runs, get, cancel, review, directoryReview, register, dismiss, init })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    ConnectHub.node,
    ConnectDirectoryRequest.node,
    Brain.node,
    BrainDatabase.node,
    Instruction.node,
    Session.node,
    SessionPrompt.node,
    Agent.node,
    ToolRegistry.node,
    RuntimeFlags.node,
    FreeModelGuests.node,
    SessionRunState.node,
    SessionStatus.node,
    Config.node,
    SessionAudience.node,
    SpendGuard.node,
    EventV2Bridge.node,
    InstanceHooks.node,
    TaskNotify.node,
  ],
})
