import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Effect, Layer, Context, Schema } from "effect"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Snapshot } from "../snapshot"
import { Storage } from "@/storage/storage"
import { Session } from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID, PartID } from "./schema"
import { SessionRunState } from "./run-state"
import { SessionSummary } from "./summary"
import { BackgroundJob } from "@/background/job"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { BrainSkill } from "@vectordevai/core/brain/skill"
import { BrainWorkflow } from "@vectordevai/core/brain/workflow"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { Instruction } from "./instruction"
import { FileState } from "@/tool/file-state"
import { TaskIsolation } from "@/task/isolation"

export class IsolatedError extends Schema.TaggedErrorClass<IsolatedError>()("SessionRevert.IsolatedError", {
  message: Schema.String,
}) {}

export class WorkflowError extends Schema.TaggedErrorClass<WorkflowError>()("SessionRevert.WorkflowError", {
  message: Schema.String,
}) {}

export const RevertInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: Schema.optional(PartID),
})
export type RevertInput = Schema.Schema.Type<typeof RevertInput>

export interface Interface {
  // SnapshotUnavailableError surfaces when the snapshot a revert needs has been
  // collected from the shadow repo. It must reach the caller: the alternative is
  // reporting a successful undo that restored nothing.
  readonly revert: (
    input: RevertInput,
  ) => Effect.Effect<
    Session.Info,
    Session.BusyError | Snapshot.SnapshotUnavailableError | IsolatedError | WorkflowError
  >
  readonly unrevert: (input: {
    sessionID: SessionID
  }) => Effect.Effect<
    Session.Info,
    Session.BusyError | Snapshot.SnapshotUnavailableError | IsolatedError | WorkflowError
  >
  readonly cleanup: (session: Session.Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@vector/SessionRevert") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snap = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const events = yield* EventV2Bridge.Service
    const summary = yield* SessionSummary.Service
    const state = yield* SessionRunState.Service
    const background = yield* BackgroundJob.Service
    const knowledge = yield* BrainKnowledge.Service
    const skills = yield* BrainSkill.Service
    const workflow = yield* BrainWorkflow.Service
    const instruction = yield* Instruction.Service
    const guests = yield* FreeModelGuests.Service
    const isolation = yield* TaskIsolation.Service
    const refuseProtected = Effect.fn("SessionRevert.refuseProtected")(function* (sessionID: SessionID) {
      if ((yield* sessions.get(sessionID).pipe(Effect.orDie)).agent === "workflow")
        return yield* new WorkflowError({
          message: "Workflow runs cannot be reverted; resume them with the workflow tool.",
        })
      if (yield* isolation.find(sessionID).pipe(Effect.orDie))
        return yield* new IsolatedError({
          message:
            "Review isolated changes with task_manage inspect (diff: true), then merge or discard them; session revert cannot change this checkout.",
        })
    })

    const revert = Effect.fn("SessionRevert.revert")(function* (input: RevertInput) {
      yield* refuseProtected(input.sessionID)
      yield* state.assertNotBusy(input.sessionID)
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      let lastUser: SessionV1.User | undefined
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)

      let rev: Session.Info["revert"]
      const patches: Snapshot.Patch[] = []
      for (const msg of all) {
        if (msg.info.role === "user") lastUser = msg.info
        const remaining = []
        for (const part of msg.parts) {
          if (rev) {
            if (part.type === "patch") patches.push(part)
            continue
          }

          if (!rev) {
            if ((msg.info.id === input.messageID && !input.partID) || part.id === input.partID) {
              const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
              rev = {
                messageID: !partID && lastUser ? lastUser.id : msg.info.id,
                partID,
              }
            }
            remaining.push(part)
          }
        }
      }

      if (!rev) return session

      rev.snapshot = session.revert?.snapshot ?? (yield* snap.track())
      if (session.revert?.snapshot) yield* snap.restore(session.revert.snapshot)
      yield* snap.revert(patches)
      if (rev.snapshot) rev.diff = yield* snap.diff(rev.snapshot)
      const range = all.filter((msg) => msg.info.id >= rev.messageID)
      const diffs = yield* summary.computeDiff({ messages: range })
      yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
      yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })
      yield* sessions.setRevert({
        sessionID: input.sessionID,
        revert: rev,
        summary: {
          additions: diffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          files: diffs.length,
        },
      })
      // Files went back, so what the session read or wrote is seeded again from the messages that remain.
      FileState.forget(input.sessionID)
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const unrevert = Effect.fn("SessionRevert.unrevert")(function* (input: { sessionID: SessionID }) {
      yield* refuseProtected(input.sessionID)
      yield* Effect.logInfo("unreverting", { sessionID: input.sessionID })
      yield* state.assertNotBusy(input.sessionID)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (!session.revert) return session
      if (session.revert.snapshot) yield* snap.restore(session.revert.snapshot)
      yield* sessions.clearRevert(input.sessionID)
      FileState.forget(input.sessionID)
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const cleanup = Effect.fn("SessionRevert.cleanup")(function* (session: Session.Info) {
      if (!session.revert) return
      const sessionID = session.id
      const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const messageID = session.revert.messageID
      const remove = [] as SessionV1.WithParts[]
      let target: SessionV1.WithParts | undefined
      for (const msg of msgs) {
        if (msg.info.id < messageID) continue
        if (msg.info.id > messageID) {
          remove.push(msg)
          continue
        }
        if (session.revert.partID) {
          target = msg
          continue
        }
        remove.push(msg)
      }
      const partID = session.revert.partID
      const idx = target && partID ? target.parts.findIndex((part) => part.id === partID) : -1
      const removeParts = target && idx >= 0 ? target.parts.slice(idx) : []
      // A background task or command launched by a call the commit removes would keep spending and editing on top of
      // the undo, and its result has nowhere to go. While the revert was pending it ran on, so a redo still got its
      // result.
      const removed = new Set<string>(remove.map((msg) => msg.info.id))
      const calls = new Set(removeParts.flatMap((part) => (part.type === "tool" ? [part.callID] : [])))
      const launched = (job: BackgroundJob.Info) => {
        const messageID = job.metadata?.parentMessageId
        if (typeof messageID !== "string") return false
        if (removed.has(messageID)) return true
        return (
          messageID === target?.info.id && typeof job.metadata?.callID === "string" && calls.has(job.metadata.callID)
        )
      }
      const jobs = yield* background.list()
      yield* Effect.forEach(
        jobs.filter(
          (job) =>
            (job.type === "task" || job.type === "shell" || job.type === "connect") &&
            job.status === "running" &&
            job.metadata?.parentSessionId === sessionID &&
            launched(job),
        ),
        (job) => background.cancel(job.id),
        { concurrency: "unbounded", discard: true },
      )
      // What the reverted runs cited loses the credit they gave it: the undo says they did not work out. So do the
      // learned skills they passed, what they drafted is withdrawn, and their workflow runs count as failures. A session
      // a guest is in takes no credit back, as it gives none: a guest's undo cannot lower the owner's records.
      const requests = [
        ...remove.flatMap((msg) => (msg.info.role === "user" ? [msg.info.id] : [])),
        ...(target && removeParts.length > 0
          ? [target.info.role === "user" ? target.info.id : target.info.parentID]
          : []),
      ]
      if (requests.length > 0 && !(yield* guests.marked(sessionID)))
        yield* instruction.place().pipe(
          Effect.flatMap((place) =>
            Effect.all([
              knowledge.reverted(place, { sessionID, requests }),
              skills.reverted(place, { sessionID, requests }),
              workflow.reverted(place, { sessionID, requests }),
            ]),
          ),
          Effect.catchCause((cause) => Effect.logWarning("brain revert credit failed", { cause })),
        )
      for (const msg of remove) {
        yield* sessions.removeMessage({ sessionID, messageID: msg.info.id })
      }
      if (target && removeParts.length > 0) {
        target.parts = target.parts.slice(0, idx)
        for (const part of removeParts) {
          yield* sessions.removePart({ sessionID, messageID: target.info.id, partID: part.id })
        }
      }
      yield* sessions.clearRevert(sessionID)
    })

    return Service.of({ revert, unrevert, cleanup })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    TaskIsolation.node,
    Session.node,
    Snapshot.node,
    Storage.node,
    EventV2Bridge.node,
    SessionSummary.node,
    SessionRunState.node,
    BackgroundJob.node,
    BrainKnowledge.node,
    BrainSkill.node,
    BrainWorkflow.node,
    Instruction.node,
    FreeModelGuests.node,
  ],
})

export * as SessionRevert from "./revert"
